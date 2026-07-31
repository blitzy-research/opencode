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
    // Containment is decided against the directories the kernel really reaches, so a project that is itself
    // reached through a link of its own still recognizes the entries that belong to it.
    const root = await fs
      .realpath(Instance.directory)
      .then(Filesystem.normalizePath)
      .catch(() => Instance.directory)
    const tree = await fs
      .realpath(Instance.worktree)
      .then(Filesystem.normalizePath)
      .catch(() => Instance.worktree)
    const volume = path.parse(root).root

    // Each endpoint is resolved against the project directory the way the write tool resolves its own, and is
    // then reduced to the entry the kernel will really touch. Joining only collapses "." and ".." segments, so
    // a link in a parent would still send every later probe, mkdir, rm, rename and cp to wherever that link
    // points, which makes a lexical path the wrong thing to authorize. Walking down from the filesystem root
    // and canonicalizing every prefix that already exists resolves those parents, while the final name is
    // attached again untouched so a link still travels as the link rather than as its target. The scope
    // spelling hands an endpoint that is physically inside the project to the shared guard as a project path
    // and one that is outside as the path the mutation will really touch.
    const paths = await Promise.all(
      [params.source, params.destination].map(async (value) => {
        const full = path.isAbsolute(value) ? value : path.join(Instance.directory, value)
        const real = path.join(
          await path
            .relative(path.parse(full).root, path.dirname(full))
            .split(path.sep)
            .reduce(
              async (prior, part) => {
                const next = path.join(await prior, part)
                return fs
                  .realpath(next)
                  .then(Filesystem.normalizePath)
                  .catch(() => next)
              },
              Promise.resolve(path.parse(full).root),
            ),
          path.basename(full),
        )
        return {
          full,
          real,
          scope:
            path.parse(real).root !== volume
              ? real
              : Filesystem.contains(root, real)
                ? path.join(Instance.directory, path.relative(root, real))
                : tree !== "/" && Filesystem.contains(tree, real)
                  ? path.join(Instance.worktree, path.relative(tree, real))
                  : real,
        }
      }),
    )
    const source = paths[0].real
    const destination = paths[1].real

    // A resolved parent can carry a wildcard of its own even though the schema refused one in the spelling,
    // and the boundary guard would put that character straight into the glob it asks to remember, where it
    // would go on matching siblings the user never saw. Neither endpoint reaches a permission pattern until
    // both are literal paths.
    if (/[*?]/.test(source)) throw new Error(`Source resolves to a path containing * or ?: ${source}`)
    if (/[*?]/.test(destination)) throw new Error(`Destination resolves to a path containing * or ?: ${destination}`)

    // Between two filesystem roots path.relative() answers with an absolute path, which the shared containment
    // helper reads as "inside", so an endpoint on another root or volume can never reach the guard's own
    // request and is consented for here with the same external_directory ask, on the same existing permission
    // key, that the guard would have made. Relocating across that boundary then falls through to the copy and
    // remove path below, where a rename reports EXDEV.
    await [source, destination]
      .filter((target) => path.parse(target).root !== volume)
      .reduce(async (prior, target) => {
        await prior
        await ctx.ask({
          permission: "external_directory",
          patterns: [path.join(path.dirname(target), "*")],
          always: [path.join(path.dirname(target), "*")],
          metadata: {
            filepath: target,
            parentDir: path.dirname(target),
          },
        })
      }, Promise.resolve())
    // Both parent scopes are guarded before either endpoint is probed. A move unlinks the entry from one
    // parent and creates it in the other, so a directory hint would authorize the moved contents instead of
    // the scope that actually changes, and no options are passed.
    await assertExternalDirectory(ctx, paths[0].scope)
    await assertExternalDirectory(ctx, paths[1].scope)

    // Renaming a path onto itself succeeds as a silent no-op, so an equal pair is refused here or not at all.
    if (source === destination) throw new Error(`Source and destination are the same path: ${source}`)
    // Reject the project and worktree roots because overwrite could recursively remove the protected root.
    if (source === root || source === tree) throw new Error(`Source must not be the project root: ${source}`)
    if (destination === root || destination === tree)
      throw new Error(`Destination must not be the project root: ${destination}`)
    // Reject ancestor/descendant pairs before consent. A contained relative path stays on the same root and
    // does not begin with a complete ".." segment.
    if (
      [path.relative(source, destination), path.relative(destination, source)].some(
        (rel) => !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
      )
    )
      throw new Error(`Source and destination overlap: one of ${source} and ${destination} contains the other`)
    // Probe the entries themselves rather than what they point at: a stat that follows links reads a dangling
    // link as missing and would allow it to be replaced unnoticed, and Bun's exists() check reports false for
    // a real directory. The device and inode pair also tells apart two names for one entry, which two hard
    // links are, because renaming between those succeeds as a no-op that leaves the source standing.
    const identity = await Promise.all(
      [source, destination].map((target) =>
        fs
          .lstat(target)
          .then((stat) => `${stat.dev}:${stat.ino}`)
          .catch(() => ""),
      ),
    )
    if (!identity[0]) throw new Error(`File or directory not found: ${source}`)
    if (identity[0] === identity[1]) throw new Error(`Source and destination are the same path: ${source}`)
    // fs.rename replaces an existing destination silently, so enforce the explicit overwrite contract first.
    if (identity[1] && !params.overwrite)
      throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)

    const from = path.relative(tree, source)
    const to = path.relative(tree, destination)

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
    // existing file.
    return FileTime.withLock(destination, async () => {
      // Every probe above ran before a permission request that can block for an unbounded time, so the state
      // that decides what is destroyed and what is reported is read again now that the lock is held.
      const stat = await fs.lstat(source).catch(() => undefined)
      if (!stat) throw new Error(`File or directory not found: ${source}`)
      const existing = await fs.lstat(destination).catch(() => undefined)
      if (existing && stat.dev === existing.dev && stat.ino === existing.ino)
        throw new Error(`Source and destination are the same path: ${source}`)
      if (existing && !params.overwrite)
        throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
      // The entry itself decides this, so a link to a directory is relocated as the single link it is.
      const directory = stat.isDirectory()
      const overwritten = existing !== undefined

      // A rename into a missing parent fails with ENOENT, so the destination's own parent is created first.
      await fs.mkdir(path.dirname(destination), { recursive: true })
      // A link in a parent can be repointed inside the permission window, and a real parent can be swapped
      // for a link, either of which would aim the rename and the removals below at entries other than the
      // pair that was authorized. Both spellings are resolved once more against the parents that now exist,
      // immediately before the first destructive step and while nothing has been created except those
      // parents.
      if (
        (await fs
          .realpath(path.dirname(paths[0].full))
          .then(Filesystem.normalizePath)
          .catch(() => "")) !== path.dirname(source) ||
        (await fs
          .realpath(path.dirname(paths[1].full))
          .then(Filesystem.normalizePath)
          .catch(() => "")) !== path.dirname(destination)
      )
        throw new Error(`Path resolution changed while permission was pending: ${source} -> ${destination}`)

      // Nothing this call found is destroyed until the relocation itself has succeeded. A destination that
      // must stay free is reserved with an exclusive create of the same kind as the source, because a rename
      // only ever replaces an entry of its own kind and reports ENOTDIR or EISDIR otherwise, and that
      // reservation is what makes a writer arriving after the probe above lose the race instead of being
      // displaced silently, whether it arrives as a file or as an empty directory. An existing destination is
      // moved aside rather than removed, so a relocation that fails afterwards can put it back untouched.
      const aside = `${destination}.opencode-move-${Bun.randomUUIDv7()}`
      const copy = `${destination}.opencode-move-${Bun.randomUUIDv7()}`
      if (!params.overwrite)
        await (directory ? fs.mkdir(destination) : fs.open(destination, "wx").then((handle) => handle.close())).catch(
          (err: NodeJS.ErrnoException) => {
            if (err.code !== "EEXIST") throw err
            throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
          },
        )
      if (overwritten) await fs.rename(destination, aside)
      // A rename carries a whole directory subtree atomically on one device, and a symbolic link travels as
      // the link itself rather than as its target, matching `mv`.
      await fs
        .rename(source, destination)
        .catch(async (err: NodeJS.ErrnoException) => {
          // Another call can relocate the source inside the window above, which surfaces as ENOENT and is
          // reported as the missing source it really is. Across a device boundary the rename fails with EXDEV
          // instead, where a copy that keeps every link verbatim into an entry beside the destination, a
          // rename of that entry into place and the removal of the source once both have succeeded are the
          // equivalent. The copy carries force so an entry already standing at the landing path cannot make
          // it silently keep stale content.
          if (err.code === "ENOENT" && !(await fs.lstat(source).catch(() => undefined)))
            throw new Error(`File or directory not found: ${source}`)
          if (err.code !== "EXDEV") throw err
          await fs
            .cp(source, copy, { recursive: true, force: true, dereference: false, verbatimSymlinks: true })
            .then(() => fs.rename(copy, destination))
            .then(() => fs.rm(source, { recursive: true, force: true }))
        })
        .catch(async (cause) => {
          // Put both endpoints back the way this call found them before the failure is reported. Everything
          // standing at the destination now was put there by this call, whether that is its reservation or a
          // copy installed before the source could be removed, so clearing it first costs the user nothing
          // and lets the entry that was moved aside go back where it was. A rollback that fails in turn must
          // not replace the failure that is being reported.
          await fs
            .rm(destination, { recursive: true, force: true })
            .then(() => (overwritten ? fs.rename(aside, destination) : undefined))
            .then(() => fs.rm(copy, { recursive: true, force: true }))
            .catch(() => {})
          throw cause
        })
      // The relocation has succeeded, so clearing what is left of the staging is not allowed to report it as
      // a failure.
      await fs.rm(aside, { recursive: true, force: true }).catch(() => {})

      // Editors learn that the content is now authoritative at the destination, then that the source path is
      // gone and the destination path is new. This reuses the existing event triple rather than introducing a
      // relocation event of its own. The relocation has already happened by now, so a listener that fails is
      // not allowed to report it as a failure or to keep the remaining notifications and the bookkeeping
      // below from running.
      await Bus.publish(File.Event.Edited, { file: destination }).catch(() => {})
      await Bus.publish(FileWatcher.Event.Updated, { file: source, event: "unlink" }).catch(() => {})
      await Bus.publish(FileWatcher.Event.Updated, { file: destination, event: "add" }).catch(() => {})

      // Mark the destination as read for later edits. Only files are touched in the language server, where
      // diagnostics are intentionally neither requested nor appended to the move result.
      FileTime.read(ctx.sessionID, destination)
      if (!directory) await LSP.touchFile(destination, true).catch(() => {})

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
    })
  },
})
