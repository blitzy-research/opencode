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
 * whole subtree -- per invocation, composing existing subsystems in one fixed order: resolve, guard,
 * validate, ask, mutate, announce, report.
 *
 * This exists so the model never has to shell out to `mv`. A shell invocation is gated by the coarse
 * `bash` permission instead of the targeted `edit` permission that governs every other file mutation,
 * and it publishes nothing on the event bus, so neither the editor nor the language server ever learns
 * that the entry changed location.
 *
 * The order of the first six steps is load bearing, because `rename` reports part of the invalid input
 * as success: renaming a path onto itself is a silent no-op and renaming over an existing destination
 * silently replaces it, so neither can be detected after the fact and both are refused beforehand.
 * Consent is collected before either endpoint is probed, so an unauthorized path is never told whether
 * it exists, and before the first write, so a denial leaves both endpoints byte identical.
 *
 * The two remaining `rename` behaviours shape the mutation: it fails with ENOENT into a parent that
 * does not exist yet, so the chain is created first, and with ENOTEMPTY over a directory that still
 * has contents, so an authorized overwrite clears the destination first.
 */
export const MoveTool = Tool.define("move", {
  description: DESCRIPTION,
  parameters: z.object({
    source: z.string().describe("The file or directory to move, as an absolute or project relative path"),
    destination: z.string().describe("The path to move it to, as an absolute or project relative path"),
    overwrite: z.boolean().optional().describe("Replace the destination if it already exists (defaults to false)"),
  }),
  async execute(params, ctx) {
    // An absolute endpoint passes through and a relative one is joined onto the project directory,
    // which is the rule the write tool applies. Every comparison below reads these resolved forms, so
    // one absolute and one relative spelling of the same location still compare as equal.
    const source = path.isAbsolute(params.source) ? params.source : path.join(Instance.directory, params.source)
    const destination = path.isAbsolute(params.destination)
      ? params.destination
      : path.join(Instance.directory, params.destination)

    // A move unlinks the entry from the source parent and creates it in the destination parent, so both
    // endpoints are gated. The shared guard is passed no options, which scopes consent to each parent
    // directory -- precisely the scope this operation mutates, where a directory hint would instead
    // grant the moved directory's own contents. Endpoints inside the project short circuit and ask for
    // nothing.
    await assertExternalDirectory(ctx, source)
    await assertExternalDirectory(ctx, destination)

    // Renaming a path onto itself succeeds as a silent no-op, so an equal pair is refused here or not at
    // all.
    if (source === destination) throw new Error(`Source and destination are the same path: ${source}`)
    // The stat based filesystem helpers are the probes used throughout, rather than the open based
    // existence check, which answers false for a real directory and would misclassify every directory
    // move as a missing source.
    if (!(await Filesystem.exists(source))) throw new Error(`File or directory not found: ${source}`)
    const directory = await Filesystem.isDir(source)
    // Probed once and kept: `rename` silently replaces an existing destination, so the kernel offers no
    // overwrite protection, and this one answer decides both the removal below and the reported flag.
    const exists = await Filesystem.exists(destination)
    if (exists && !params.overwrite)
      throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)

    const from = path.relative(Instance.worktree, source)
    const to = path.relative(Instance.worktree, destination)

    // The destination is the sole pattern, which is the request the write tool makes for a file it is
    // about to rewrite, so a relocation is governed by the same targeted `edit` permission as every
    // other mutation rather than by a key of its own. An `edit` that no rule mentions prompts rather
    // than allows, and a configured deny raises before anything moves.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source,
        destination,
      },
    })

    // Serialized on the destination, as the file time module prescribes for every tool that overwrites
    // an existing file, so concurrent writes to that path cannot interleave with this relocation.
    return FileTime.withLock(destination, async () => {
      // Recursive creation is safe on directories that already exist, and it is what makes a move into
      // a subdirectory that does not exist yet succeed instead of failing with ENOENT.
      await fs.mkdir(path.dirname(destination), { recursive: true })
      // Clearing an authorized overwrite target first is what allows a directory to replace a directory
      // that still has contents, and it stops stale content from surviving underneath the move.
      if (exists && params.overwrite) await fs.rm(destination, { recursive: true, force: true })
      // A rename carries a whole directory subtree atomically on one device, and a symbolic link travels
      // as the link itself rather than as its target, matching `mv`. Across a device boundary it fails
      // with EXDEV, where a recursive copy followed by removing the source is the equivalent.
      await fs.rename(source, destination).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EXDEV") throw err
        await fs
          .cp(source, destination, { recursive: true })
          .then(() => fs.rm(source, { recursive: true, force: true }))
      })

      // Editors learn that the content is now authoritative at the destination, then that the source
      // path is gone and the destination path is new. This reuses the existing event triple rather than
      // introducing a relocation event of its own.
      await Bus.publish(File.Event.Edited, { file: destination })
      await Bus.publish(FileWatcher.Event.Updated, { file: source, event: "unlink" })
      await Bus.publish(FileWatcher.Event.Updated, { file: destination, event: "add" })

      // Recording the read stops a later edit of the relocated entry from demanding a fresh read. Only
      // files are opened in the language server, since a directory is not a document, and no diagnostics
      // are collected because a move leaves the content byte identical.
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
