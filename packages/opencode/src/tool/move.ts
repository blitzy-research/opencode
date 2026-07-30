import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Tool } from "./tool"
import DESCRIPTION from "./move.txt"
import { assertExternalDirectory } from "./external-directory"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { LSP } from "../lsp"

/**
 * Relocates exactly one filesystem entry -- a single file, or a single directory together with its
 * whole subtree -- per invocation, in a fixed order: resolve, guard, validate, ask, mutate,
 * announce, report.
 *
 * This exists so the model never has to shell out to `mv`. A shell invocation would be gated by the
 * coarse `bash` permission instead of the targeted `edit` permission that governs every other file
 * mutation, and it would publish nothing on the event bus, leaving the editor and the language
 * server unaware that the entry changed location.
 *
 * The validation order is load bearing, because the rename syscall reports success for two of the
 * three rejected inputs: relocating a path onto itself is a silent no-op, and relocating over an
 * existing destination file silently replaces it. Neither condition can be recovered from after the
 * fact, so both are pre-checked here instead of being delegated to the kernel.
 */
export const MoveTool = Tool.define("move", {
  description: DESCRIPTION,
  parameters: z.object({
    source: z.string().describe("The file or directory to move, as an absolute or project relative path"),
    destination: z.string().describe("The path to move it to, as an absolute or project relative path"),
    overwrite: z.boolean().optional().describe("Replace the destination if it already exists (defaults to false)"),
  }),
  async execute(params, ctx) {
    // Both endpoints are resolved up front so every comparison below runs on absolute paths. That is
    // what makes the same path guard correct when the model spells one endpoint absolutely and the
    // other relative to the project.
    const source = path.isAbsolute(params.source) ? params.source : path.join(Instance.directory, params.source)
    const destination = path.isAbsolute(params.destination)
      ? params.destination
      : path.join(Instance.directory, params.destination)

    // A move unlinks the entry from the source parent and creates it in the destination parent, so
    // both endpoints are gated. No options are passed, which scopes consent to each parent directory
    // -- precisely the scope this operation mutates.
    await assertExternalDirectory(ctx, source)
    await assertExternalDirectory(ctx, destination)

    if (source === destination) throw new Error(`Source and destination are the same path: ${source}`)

    // Stat based probes are used throughout: the open based existence check reports false for a real
    // directory, which would misclassify every directory move as a missing source.
    if (!(await Filesystem.exists(source))) throw new Error(`File or directory not found: ${source}`)

    // Probed once and reused three times: to reject an unrequested overwrite, to decide whether the
    // destination has to be cleared before the rename, and to report whether something was replaced.
    const exists = await Filesystem.exists(destination)
    if (exists && !params.overwrite)
      throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)

    // The kind is captured before the mutation, because the source no longer exists afterwards.
    const directory = await Filesystem.isDir(source)

    const from = path.relative(Instance.worktree, source)
    const to = path.relative(Instance.worktree, destination)

    // Asked after validation, so rejected input fails without prompting, and before the first
    // filesystem call, so a denial leaves both endpoints byte identical.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source,
        destination,
      },
    })

    // Serialized against concurrent writes to the destination, as every tool that overwrites an
    // existing file is expected to be. The read before write assertion is deliberately skipped: the
    // overwrite contract of this tool is the explicit flag, not a prior read of the destination.
    return FileTime.withLock(destination, async () => {
      // A rename into a missing parent fails with ENOENT, so the chain is created first. Recursive
      // creation is safe on directories that already exist.
      await fs.mkdir(path.dirname(destination), { recursive: true })

      // Renaming onto a non-empty directory fails with ENOTEMPTY, and a remnant of the previous
      // destination would otherwise silently outlive the move, so an authorized overwrite clears the
      // destination first. Guarded on the flag as well as the probe so this recursive removal can
      // never run without explicit consent.
      if (exists && params.overwrite) await fs.rm(destination, { recursive: true, force: true })

      // A rename carries a whole directory subtree atomically on one device, but fails with EXDEV
      // across a device boundary, where a recursive copy followed by removal of the source is the
      // equivalent. A symbolic link is relocated as the link itself either way, matching `mv`.
      await fs.rename(source, destination).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EXDEV") throw err
        await fs
          .cp(source, destination, { recursive: true })
          .then(() => fs.rm(source, { recursive: true, force: true }))
      })

      // Editors learn that the content is now authoritative at the destination, then that the source
      // path is gone and the destination path is new. This reuses the existing event triple rather
      // than introducing a dedicated relocation event.
      await Bus.publish(File.Event.Edited, { file: destination })
      await Bus.publish(FileWatcher.Event.Updated, { file: source, event: "unlink" })
      await Bus.publish(FileWatcher.Event.Updated, { file: destination, event: "add" })

      // Recording the read stops a subsequent edit of the relocated entry from demanding a fresh
      // read. Only files are opened in the language server, since a directory is not a document, and
      // no diagnostics are collected because a move leaves the content byte identical.
      FileTime.read(ctx.sessionID, destination)
      if (!directory) await LSP.touchFile(destination, true)

      return {
        title: `${from} -> ${to}`,
        metadata: {
          source,
          destination,
          directory,
          overwritten: exists,
        },
        output: directory ? `Moved directory ${from} to ${to}` : `Moved file ${from} to ${to}`,
      }
    })
  },
})
