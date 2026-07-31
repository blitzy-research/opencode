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
import { Log } from "../util/log"
import { LSP } from "../lsp"

const log = Log.create({ service: "tool.move" })

// A symbolic link is a filesystem entry of its own, and rename relocates the link rather than what it points
// at. The stat based Filesystem helpers follow the link instead, so on their own they read a dangling link as
// missing and a link to a directory as a directory. An lstat settles both questions about the entry itself.
const symlink = (target: string) =>
  fs
    .lstat(target)
    .then((stat) => stat.isSymbolicLink())
    .catch(() => false)
const entry = async (target: string) => (await symlink(target)) || (await Filesystem.exists(target))
const folder = async (target: string) => !(await symlink(target)) && (await Filesystem.isDir(target))

// Where a path that exists really lives, with the casing the filesystem itself reports on Windows.
const canonical = (target: string) =>
  fs
    .realpath(target)
    .then(Filesystem.normalizePath)
    .catch(() => path.resolve(target))

// path.resolve only collapses "." and ".." segments. A link in a parent still sends every later probe, mkdir,
// rm, rename and cp to wherever that link points, so a lexical path is the wrong thing to authorize. The
// nearest ancestor that exists is canonicalized and the segments below it are attached again, which names the
// entry the kernel will really touch while leaving the entry itself untouched so a link still travels as the
// link. Authorizing and mutating this one identity is what keeps consent and effect on the same path.
const physical = async (target: string): Promise<string> => {
  const parent = path.dirname(target)
  if (parent === target) return target
  const real = await fs
    .realpath(parent)
    .then(Filesystem.normalizePath)
    .catch(() => undefined)
  return path.join(real ?? (await physical(parent)), path.basename(target))
}

// An endpoint is resolved against the project the way the read and write tools resolve theirs, then reduced
// to the identity above.
const resolved = (value: string) =>
  physical(path.resolve(path.isAbsolute(value) ? value : path.join(Instance.directory, value)))

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
    // Physical identities, so equivalent spellings and aliased parents share the equality checks, the
    // authorized scope, the lock identity and the entries that are actually mutated.
    const source = await resolved(params.source)
    const destination = await resolved(params.destination)
    const root = await canonical(Instance.directory)
    const tree = await canonical(Instance.worktree)
    const volume = path.parse(root).root

    // Between two filesystem roots path.relative() answers with an absolute path, which the shared
    // containment helper reads as "inside", so an endpoint on another root or volume cannot be authorized
    // here at all and is refused instead of being silently treated as part of the project.
    if (path.parse(source).root !== volume)
      throw new Error(`Source must be on the project filesystem root ${volume}: ${source}`)
    if (path.parse(destination).root !== volume)
      throw new Error(`Destination must be on the project filesystem root ${volume}: ${destination}`)

    // The shared guard decides containment lexically against the project paths, so an endpoint that is
    // physically inside the project is spelled inside it again and one that is physically outside is handed
    // over as the path the mutation will really touch. Both parent scopes are guarded before either path is
    // probed, and a directory hint would authorize the moved contents instead of the scope that changes.
    const scope = (target: string) => {
      if (Filesystem.contains(root, target)) return path.join(Instance.directory, path.relative(root, target))
      if (tree !== "/" && Filesystem.contains(tree, target))
        return path.join(Instance.worktree, path.relative(tree, target))
      return target
    }
    await assertExternalDirectory(ctx, scope(source))
    await assertExternalDirectory(ctx, scope(destination))

    // Renaming a path onto itself succeeds as a silent no-op, so an equal pair is refused here or not at
    // all.
    if (source === destination) throw new Error(`Source and destination are the same path: ${source}`)
    // Reject the project and worktree roots because overwrite could recursively remove the protected root.
    if (source === root || source === tree) throw new Error(`Source must not be the project root: ${source}`)
    if (destination === root || destination === tree)
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
    // Probe entries rather than open files: Bun's file exists() check reports false for a real directory.
    if (!(await entry(source))) throw new Error(`File or directory not found: ${source}`)
    // fs.rename can replace an existing destination silently, so enforce the explicit overwrite contract first.
    if ((await entry(destination)) && !params.overwrite)
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
      // Every probe above ran before a permission request that can block for an unbounded time, so the
      // state deciding what is destroyed and what is reported is read again now that the lock is held. A
      // link in a parent can be repointed inside that window as well, which would aim both endpoints at
      // entries other than the pair the user consented to.
      if ((await resolved(params.source)) !== source || (await resolved(params.destination)) !== destination)
        throw new Error(`Path resolution changed while permission was pending: ${source} -> ${destination}`)
      if (!(await entry(source))) throw new Error(`File or directory not found: ${source}`)
      const overwritten = await entry(destination)
      if (overwritten && !params.overwrite)
        throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
      const directory = await folder(source)

      await fs.mkdir(path.dirname(destination), { recursive: true })
      // Nothing the call found is destroyed until the relocation itself has succeeded. A free destination is
      // reserved with an exclusive create, which is the only way a writer arriving after the probe above
      // loses the race rather than being replaced silently by the rename; a directory source needs no
      // reservation because a rename can only ever displace an empty directory and reports ENOTEMPTY or
      // ENOTDIR for anything that holds data. An existing destination that a rename cannot replace on its
      // own is moved aside instead of removed, so a relocation that fails afterwards can put it back.
      const aside = `${destination}.opencode-move-${Bun.randomUUIDv7()}`
      const reserved = !params.overwrite && !directory
      const staged = overwritten && (directory || (await folder(destination)))
      if (reserved)
        await fs
          .open(destination, "wx")
          .then((handle) => handle.close())
          .catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "EEXIST") throw err
            throw new Error(`Destination already exists: ${destination}. Pass overwrite: true to replace it`)
          })
      if (staged) await fs.rename(destination, aside)
      // A rename carries a whole directory subtree atomically on one device, and a symbolic link travels
      // as the link itself rather than as its target, matching `mv`.
      await fs
        .rename(source, destination)
        .catch(async (err: NodeJS.ErrnoException) => {
          // Another call can relocate the source inside the window above, which surfaces as ENOENT and is
          // reported as the missing source it really is. Across a device boundary the rename fails with
          // EXDEV instead, where a copy that keeps every link verbatim into an entry beside the
          // destination, a rename of that entry into place and the removal of the source once both have
          // succeeded are the equivalent. The copy carries force so an entry already standing at the
          // landing path cannot make it silently keep stale content.
          if (err.code === "ENOENT" && !(await entry(source))) throw new Error(`File or directory not found: ${source}`)
          if (err.code !== "EXDEV") throw err
          const copy = `${destination}.opencode-move-${Bun.randomUUIDv7()}`
          await fs
            .cp(source, copy, { recursive: true, force: true, dereference: false, verbatimSymlinks: true })
            .then(() => fs.rename(copy, destination))
            .then(() => fs.rm(source, { recursive: true, force: true }))
            .catch(async (cause) => {
              await fs.rm(copy, { recursive: true, force: true })
              throw cause
            })
        })
        .catch(async (cause) => {
          // Leave both endpoints exactly as the call found them before the failure is reported.
          if (reserved) await fs.rm(destination, { recursive: true, force: true })
          if (staged) await fs.rename(aside, destination)
          throw cause
        })
      if (staged) await fs.rm(aside, { recursive: true, force: true })

      // Editors learn that the content is now authoritative at the destination, then that the source
      // path is gone and the destination path is new. This reuses the existing event triple rather than
      // introducing a relocation event of its own. The relocation has already happened by now, so a
      // listener that fails is logged instead of being allowed to report it as a failure or to keep the
      // remaining notifications and the bookkeeping below from running.
      const announce = (pending: Promise<unknown>) => pending.catch((cause) => log.error("notify", { cause }))
      await announce(Bus.publish(File.Event.Edited, { file: destination }))
      await announce(Bus.publish(FileWatcher.Event.Updated, { file: source, event: "unlink" }))
      await announce(Bus.publish(FileWatcher.Event.Updated, { file: destination, event: "add" }))

      // Mark the destination as read for later edits. Only files are touched in the LSP, where
      // diagnostics are awaited but intentionally not appended to the move result.
      FileTime.read(ctx.sessionID, destination)
      if (!directory) await announce(LSP.touchFile(destination, true))

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
