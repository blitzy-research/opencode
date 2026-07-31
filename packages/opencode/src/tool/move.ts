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

export const MoveTool = Tool.define("move", {
  description: DESCRIPTION,
  parameters: z.object({
    // Reject permission wildcards in the schema so user input cannot broaden an external-directory "always" grant.
    source: z
      .string()
      .min(1)
      .refine((value) => !/[*?]/.test(value), "Source must not contain * or ?")
      .describe("The file or directory to move, as an absolute or project relative path, without * or ?"),
    destination: z
      .string()
      .min(1)
      .refine((value) => !/[*?]/.test(value), "Destination must not contain * or ?")
      .describe("The path to move it to, as an absolute or project relative path, without * or ?"),
    overwrite: z.boolean().optional().describe("Replace the destination if it already exists (defaults to false)"),
  }),
  async execute(params, ctx) {
    // Normalize resolved paths so equivalent spellings share equality checks and lock identities.
    const source = path.resolve(
      path.isAbsolute(params.source) ? params.source : path.join(Instance.directory, params.source),
    )
    const destination = path.resolve(
      path.isAbsolute(params.destination) ? params.destination : path.join(Instance.directory, params.destination),
    )

    // Guard both parent scopes before probing either path; a directory hint would authorize the moved contents instead.
    await assertExternalDirectory(ctx, source)
    await assertExternalDirectory(ctx, destination)

    // Renaming a path onto itself succeeds as a silent no-op, so an equal pair is refused here or not at
    // all.
    if (source === destination) throw new Error(`Source and destination are the same path: ${source}`)
    // Reject normalized project/worktree roots because overwrite could recursively remove the protected root.
    if (source === path.resolve(Instance.directory) || source === path.resolve(Instance.worktree))
      throw new Error(`Source must not be the project root: ${source}`)
    if (destination === path.resolve(Instance.directory) || destination === path.resolve(Instance.worktree))
      throw new Error(`Destination must not be the project root: ${destination}`)
    // Reject ancestor/descendant pairs before consent. A contained relative path stays on the same root and
    // does not begin with a complete ".." segment.
    const rel = path.relative(source, destination)
    const inverse = path.relative(destination, source)
    const walk = `..${path.sep}`
    if (
      (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(walk)) ||
      (!path.isAbsolute(inverse) && inverse !== ".." && !inverse.startsWith(walk))
    )
      throw new Error(`Source and destination overlap: one of ${source} and ${destination} contains the other`)
    // Use the stat based Filesystem helpers: Bun's file exists() check reports false for a real directory.
    if (!(await Filesystem.exists(source))) throw new Error(`File or directory not found: ${source}`)
    // fs.rename can replace an existing destination silently, so enforce the explicit overwrite contract first.
    if ((await Filesystem.exists(destination)) && !params.overwrite)
      throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)

    const from = path.relative(Instance.worktree, source)
    const to = path.relative(Instance.worktree, destination)

    // Ask after validation and before the first filesystem mutation so denial is side-effect free.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source,
        destination,
      },
    })

    // Serialized on the destination, as the file time module prescribes for every tool that overwrites an
    // existing file, and on the source too because a move mutates both. Sorted, so two concurrent moves can
    // never hold one lock each while waiting for the other; the keys differ because equality was refused.
    const locks = [source, destination].sort()
    return FileTime.withLock(locks[0], () =>
      FileTime.withLock(locks[1], async () => {
        // Every probe above ran before a permission request that can block for an unbounded time, so the
        // state deciding what is destroyed and what is reported is read again now that both locks are held.
        if (!(await Filesystem.exists(source))) throw new Error(`File or directory not found: ${source}`)
        const overwritten = await Filesystem.exists(destination)
        if (overwritten && !params.overwrite)
          throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
        const directory = await Filesystem.isDir(source)

        await fs.mkdir(path.dirname(destination), { recursive: true })
        // Pre-remove the target when either endpoint is a directory; file-to-file rename replaces in place
        // without an early destructive step.
        if (overwritten && params.overwrite && (directory || (await Filesystem.isDir(destination))))
          await fs.rm(destination, { recursive: true, force: true })
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

        // Mark the destination as read for later edits. Only files are touched in the LSP, where
        // diagnostics are awaited but intentionally not appended to the move result.
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
