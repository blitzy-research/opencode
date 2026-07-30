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
 * whole subtree -- per invocation, in a fixed order: resolve, guard, validate, ask, lock, mutate,
 * announce, report.
 *
 * This exists so the model never has to shell out to `mv`. A shell invocation would be gated by the
 * coarse `bash` permission instead of the targeted `edit` permission that governs every other file
 * mutation, and it would publish nothing on the event bus, leaving the editor and the language
 * server unaware that the entry changed location.
 *
 * The validation order is load bearing. Part of the rejected input is reported as success by the
 * rename syscall -- relocating a path onto itself is a silent no-op, and relocating over an existing
 * destination file silently replaces it -- and the rest turns destructive before a rename is even
 * attempted, because clearing an authorized overwrite destination deletes the project directory, the
 * source, or part of the source subtree whenever the two endpoints are not disjoint. Neither class
 * can be recovered from afterwards, so both are pre-checked here, against normalized spellings that
 * a symlinked parent cannot alias apart. Everything that decides what gets destroyed is then checked
 * once more under the locks of both endpoints, because the first pass ran before a permission prompt
 * that can block for an arbitrarily long time, during which either endpoint can change underneath.
 */
export const MoveTool = Tool.define("move", {
  description: DESCRIPTION,
  parameters: z.object({
    source: z.string().describe("The file or directory to move, as an absolute or project relative path"),
    destination: z.string().describe("The path to move it to, as an absolute or project relative path"),
    overwrite: z.boolean().optional().describe("Replace the destination if it already exists (defaults to false)"),
  }),
  async execute(params, ctx) {
    // Rejected before resolution, because a blank endpoint is not a path: joining one onto the
    // project directory collapses to the project directory itself, which an authorized overwrite
    // would then recursively remove.
    if (!params.source.trim()) throw new Error("Source path must not be empty")
    if (!params.destination.trim()) throw new Error("Destination path must not be empty")

    // Both endpoints are resolved and lexically normalized up front, so every comparison, permission
    // pattern, lock key and filesystem call below runs on a single spelling of each path. An absolute
    // endpoint passes through and a relative one is joined onto the project directory, which is the
    // rule the read and write tools apply; normalizing on top of that is what stops `dir/./file` and
    // `dir/file` from naming one entry while comparing as two.
    const source = path.resolve(Instance.directory, params.source)
    const destination = path.resolve(Instance.directory, params.destination)

    // Neither endpoint may be the project root itself. This is the other half of the blank endpoint
    // defence, since `.`, `./`, a bare separator and the project path spelled out in full all land
    // here, and it also keeps the destination permission pattern from degrading to an empty string.
    if (source === Instance.directory || source === Instance.worktree)
      throw new Error(`Source must not be the project root: ${source}`)
    if (destination === Instance.directory || destination === Instance.worktree)
      throw new Error(`Destination must not be the project root: ${destination}`)

    // A move unlinks the entry from the source parent and creates it in the destination parent, so
    // both endpoints are gated. No options are passed, which scopes consent to each parent directory
    // -- precisely the scope this operation mutates.
    await assertExternalDirectory(ctx, source)
    await assertExternalDirectory(ctx, destination)

    // Two endpoints naming one entry, and either endpoint nested inside the other, are both fatal and
    // both invisible afterwards: renaming a path onto itself succeeds as a silent no-op, and clearing
    // an overlapping destination deletes the source or part of its subtree before the rename runs.
    // Applied to the lexical spellings here, and to the canonical ones once the source is known.
    const distinct = (a: string, b: string) => {
      if (a === b) throw new Error(`Source and destination are the same path: ${source}`)
      if (Filesystem.overlaps(a, b))
        throw new Error(`Source and destination overlap: one of ${source} and ${destination} contains the other`)
    }
    distinct(source, destination)

    // lstat describes the entry rather than whatever it points at, which is the semantic this tool
    // moves by: a link travels as the link itself, so a link whose target is missing still exists
    // here, and a link to a directory is not a directory. The `Filesystem` probes follow the link, so
    // they would instead report the first as absent and the second as a directory.
    const stat = (p: string) => fs.lstat(p).catch(() => undefined)

    if (!(await stat(source))) throw new Error(`File or directory not found: ${source}`)

    // A symlinked parent lets two unrelated spellings reach one entry, so the pair is compared again
    // on its canonical form: the parent chain is resolved, while the final component is left as
    // written so the entry is still weighed as itself instead of as its target. Falls back to the
    // lexical path when the parent does not exist yet, which is exactly when no alias can exist.
    const identity = (p: string) =>
      fs
        .realpath(path.dirname(p))
        .then((parent) => path.join(parent, path.basename(p)))
        .catch(() => p)
    const canonical = { source: await identity(source), destination: await identity(destination) }
    distinct(canonical.source, canonical.destination)

    if ((await stat(destination)) && !params.overwrite)
      throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)

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

    // Both endpoints are locked, because a move mutates both, and in sorted order so two concurrent
    // moves can never hold one lock each while waiting for the other. The two keys are known to
    // differ, since canonical identity was rejected above, so the nesting cannot block on itself.
    const locks = [canonical.source, canonical.destination].sort()
    return FileTime.withLock(locks[0], () =>
      FileTime.withLock(locks[1], async () => {
        // Every probe above ran before the permission prompt, which can block for an arbitrarily long
        // time, so the state that decides what is destroyed is read again now that both endpoints are
        // held. The result and the metadata are derived from this pass, which is the state the move
        // actually replaces.
        const entry = await stat(source)
        if (!entry) throw new Error(`File or directory not found: ${source}`)
        const overwritten = !!(await stat(destination))
        if (overwritten && !params.overwrite)
          throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
        const directory = entry.isDirectory()

        // A rename into a missing parent fails with ENOENT, so the chain is created first. Recursive
        // creation is safe on directories that already exist.
        await fs.mkdir(path.dirname(destination), { recursive: true })

        // Renaming onto a non-empty directory fails with ENOTEMPTY, and a remnant of the previous
        // destination would otherwise silently outlive the move, so an authorized overwrite clears
        // the destination first. Guarded on the flag as well as the probe so this recursive removal
        // can never run without explicit consent.
        if (overwritten && params.overwrite) await fs.rm(destination, { recursive: true, force: true })

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
        // read. Only files are opened in the language server, since a directory is not a document,
        // and no diagnostics are collected because a move leaves the content byte identical.
        FileTime.read(ctx.sessionID, destination)
        if (!directory) await LSP.touchFile(destination, true)

        return {
          title: `${from} -> ${to}`,
          metadata: {
            source,
            destination,
            directory,
            overwritten,
          },
          output: directory ? `Moved directory ${from} to ${to}` : `Moved file ${from} to ${to}`,
        }
      }),
    )
  },
})
