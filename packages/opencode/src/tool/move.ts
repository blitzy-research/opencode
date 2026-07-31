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
    // A permission pattern is built from these values, so the schema refuses the two glob characters that
    // would otherwise broaden an external_directory grant past the path the user approved. A NUL byte is
    // refused here as well, so a path no filesystem can hold is reported by this tool rather than by the
    // runtime rejecting its own argument further down.
    source: z
      .string()
      .min(1)
      .refine((value) => !/[*?]/.test(value), "Source must not contain * or ?")
      .refine((value) => !value.includes("\u0000"), "Source must not contain a NUL byte")
      .describe("The file or directory to move, as an absolute or project relative path, without * or ?"),
    destination: z
      .string()
      .min(1)
      .refine((value) => !/[*?]/.test(value), "Destination must not contain * or ?")
      .refine((value) => !value.includes("\u0000"), "Destination must not contain a NUL byte")
      .describe("The path to move it to, as an absolute or project relative path, without * or ?"),
    overwrite: z.boolean().optional().describe("Replace the destination if it already exists (defaults to false)"),
  }),
  async execute(params, ctx) {
    // Keep the caller's spelling for permission, locking, events and reporting; canonicalize the parent
    // segments that already exist for the boundary check and the mutation, without dereferencing the entry.
    const [source, destination] = await Promise.all(
      [params.source, params.destination].map(async (value) => {
        const full = path.isAbsolute(value) ? value : path.join(Instance.directory, value)
        return {
          full,
          real: path.join(
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
          ),
        }
      }),
    )
    // Canonicalized parents can introduce * or ?, so reject them before a remembered pattern is built. The
    // spelling the caller passed is the one reported, because consent for the resolved path comes below.
    if (/[*?]/.test(source.real)) throw new Error(`Source resolves to a path containing * or ?: ${source.full}`)
    if (/[*?]/.test(destination.real))
      throw new Error(`Destination resolves to a path containing * or ?: ${destination.full}`)

    // Guard the caller's spelling and the canonical path of each endpoint before existence and identity
    // checks, with the default parent glob, because a move mutates each parent, not a directory's contents.
    await assertExternalDirectory(ctx, source.full)
    if (source.real !== source.full) await assertExternalDirectory(ctx, source.real)
    await assertExternalDirectory(ctx, destination.full)
    if (destination.real !== destination.full) await assertExternalDirectory(ctx, destination.real)

    // rename(p, p) succeeds as a no-op, so an equal canonical identity is refused here or not at all.
    if (source.real === destination.real) throw new Error(`Source and destination are the same path: ${source.full}`)
    // Neither the project directory nor the worktree may be relocated or replaced, because replacing a
    // destination removes it recursively. Both are canonicalized too, so a project that is itself reached
    // through a link still recognizes itself.
    const roots = await Promise.all(
      [Instance.directory, Instance.worktree].map((dir) =>
        fs
          .realpath(dir)
          .then(Filesystem.normalizePath)
          .catch(() => dir),
      ),
    )
    if (roots.includes(source.real))
      throw new Error(`Source must not be the project directory or the repository root: ${source.full}`)
    if (roots.includes(destination.real))
      throw new Error(`Destination must not be the project directory or the repository root: ${destination.full}`)
    // An entry cannot be moved inside itself, and a destination cannot swallow its own source. A contained
    // path stays on the same root and does not begin with a complete ".." segment.
    if (
      [path.relative(source.real, destination.real), path.relative(destination.real, source.real)].some(
        (rel) => !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
      )
    )
      throw new Error(
        `Source and destination overlap: one of ${source.full} and ${destination.full} contains the other`,
      )

    // lstat joins the stat based helpers so a dangling link counts as a movable entry and a directory is
    // still detected correctly. The kind this entry reports is settled again once permission has returned,
    // because it decides how the destination is reserved, what the language server is told and what is
    // reported, and only the entry that is still there when the move runs may decide any of that.
    const stat = await fs.lstat(source.real).catch(() => undefined)
    if (!(await Filesystem.exists(source.real)) && !stat) throw new Error(`File or directory not found: ${source.full}`)

    // fs.rename replaces an existing entry silently, so this probe drives overwrite handling and metadata.
    const entry = await fs.lstat(destination.real).catch(() => undefined)
    const exists = (await Filesystem.exists(destination.real)) || entry !== undefined
    // Two hard links are two names for one entry rather than two entries, and renaming between those
    // succeeds as a no-op that would leave the source standing while this call reported a relocation.
    if (stat && entry && stat.dev === entry.dev && stat.ino === entry.ino)
      throw new Error(`Source and destination are the same path: ${source.full}`)
    if (exists && !params.overwrite)
      throw new Error(`Destination already exists: ${destination.full}. Pass overwrite: true to replace it`)

    const from = path.relative(Instance.worktree, source.full)
    const to = path.relative(Instance.worktree, destination.full)

    // Request destination edit permission after validation and before mutation, so an invalid move never
    // asks for edit and a denial is free of side effects.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source: source.full,
        destination: destination.full,
      },
    })

    // Serialize by the caller visible destination so a later edit of that same spelling waits for this move.
    return FileTime.withLock(destination.full, async () => {
      // Re-resolve the parents that exist now that permission has returned, to catch a link swapped in while
      // it was pending; a parent that still does not exist cannot yet redirect the operation.
      if (
        (
          await Promise.all(
            [source, destination].map((endpoint) =>
              fs
                .realpath(path.dirname(endpoint.full))
                .then(Filesystem.normalizePath)
                .then((real) => real === path.dirname(endpoint.real))
                .catch(() => true),
            ),
          )
        ).includes(false)
      )
        throw new Error(`Path resolution changed while permission was pending: ${source.full} -> ${destination.full}`)

      // Stat the source again, before anything is created, to catch an entry swapped in while permission was
      // pending. dev and ino name the entry itself, and the kind is compared as well because a freed inode
      // number can be handed out again to an entry of another kind. Relocating a substitute would report the
      // entry that was validated while moving the one that replaced it, so it is refused here instead.
      const current = await fs.lstat(source.real).catch(() => undefined)
      if (!current) throw new Error(`File or directory not found: ${source.full}`)
      if (
        !stat ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.isDirectory() !== stat.isDirectory() ||
        current.isSymbolicLink() !== stat.isSymbolicLink()
      )
        throw new Error(`Source changed while permission was pending: ${source.full}`)
      // The kind comes from the entry itself, so a link to a directory is relocated as the single link it is.
      const directory = current.isDirectory()

      // A rename into a missing parent fails with ENOENT, so the destination's parents are created below. The
      // ones this call is about to add are collected first, deepest first, rather than read back from the
      // mkdir result, because a recursive mkdir that fails partway still leaves what it did create behind.
      const parents = await Promise.all(
        path
          .relative(path.parse(destination.real).root, path.dirname(destination.real))
          .split(path.sep)
          .filter((part) => part !== "")
          .map((_, index, parts) =>
            path.join(path.parse(destination.real).root, ...parts.slice(0, parts.length - index)),
          )
          .map((dir) => Filesystem.exists(dir).then((found) => (found ? "" : dir))),
      ).then((list) => list.filter((dir) => dir !== ""))
      // Undo those parent directories, deepest first: rmdir refuses one that is not empty, so walking back up
      // stops at the first directory that is still in use and only what this call added and nobody else
      // touched comes down. A path that rmdir refused and that is not there either was never created, by a
      // failed mkdir or because the filesystem cannot hold that name, and it does not stop the walk. Anything
      // that is there, including a file or a link standing where a parent was wanted, does.
      const prune = () =>
        parents.reduce(
          (prior, dir) =>
            prior.then((going) =>
              going
                ? fs.rmdir(dir).then(
                    () => true,
                    () => Filesystem.exists(dir).then((found) => !found),
                  )
                : false,
            ),
          Promise.resolve(true),
        )
      await fs.mkdir(path.dirname(destination.real), { recursive: true }).catch(async (cause: Error) => {
        // Whatever refused the parents, an entry standing in the way as much as a name the filesystem cannot
        // hold, the directories this call did create come down before the failure leaves here, and the
        // platform reason travels inside a message that names the destination it was for.
        await prune()
        throw new Error(`Destination parents could not be created for ${to}: ${cause.message}`, { cause })
      })

      // Reserve a free destination with an entry of the source's kind, or stage an existing destination aside,
      // so cooperating moves cannot displace one another silently and the old entry survives for a rollback.
      const aside = `${destination.real}.opencode-move-${Bun.randomUUIDv7()}`
      // A cross device copy is assembled here first, beside the destination and so on its device, because a
      // copy of a link cannot be written onto the path the reservation already occupies.
      const copy = `${destination.real}.opencode-move-${Bun.randomUUIDv7()}`
      if (!exists)
        await (
          directory ? fs.mkdir(destination.real) : fs.open(destination.real, "wx").then((handle) => handle.close())
        ).catch(async (err: NodeJS.ErrnoException) => {
          // Whatever refused the reservation, a name the filesystem cannot hold as much as a destination another
          // writer has taken, the parents this call created are its only trace, so they come down before the
          // failure leaves here. An entry in the way and the directory holding it are left alone, because
          // pruning stops at a directory that is still in use.
          await prune()
          if (err.code !== "EEXIST") throw err
          throw new Error(`Destination already exists: ${destination.full}. Pass overwrite: true to replace it`)
        })
      if (exists)
        await fs.rename(destination.real, aside).catch(async (err: Error) => {
          // Nothing has been relocated yet, so the parents this call created are its only trace to remove.
          await prune()
          throw err
        })

      // Rename carries a whole directory subtree atomically on one device and relocates a symbolic link as
      // the link itself rather than as its target, matching `mv`.
      await fs
        .rename(source.real, destination.real)
        .catch(async (err: NodeJS.ErrnoException) => {
          // Report a source that raced away as missing.
          if (err.code === "ENOENT" && !(await fs.lstat(source.real).catch(() => undefined)))
            throw new Error(`File or directory not found: ${source.full}`)
          // Windows refuses a rename onto a directory, including the empty one reserved here, so that
          // reservation is given up and the rename tried once more. rmdir refuses a directory that is not
          // empty, so a reservation another writer has since filled stops the retry and the failure stands.
          if (!exists && directory && ["EPERM", "EACCES", "EEXIST", "ENOTEMPTY"].includes(err.code ?? ""))
            return fs.rmdir(destination.real).then(
              () => fs.rename(source.real, destination.real),
              () => {
                throw err
              },
            )
          if (err.code !== "EXDEV") throw err
          // On EXDEV, copy without dereferencing links, and remove the source only once the copy has
          // succeeded. A copy of a link cannot be written onto the reserved destination, so it is assembled
          // beside it and a single rename then puts the finished entry in its place.
          await fs
            .cp(source.real, copy, {
              recursive: true,
              force: true,
              dereference: false,
              verbatimSymlinks: true,
            })
            .then(() => fs.rename(copy, destination.real))
            .then(() => fs.rm(source.real, { recursive: true, force: true }))
        })
        .catch(async (cause: Error) => {
          // Attempt to restore the pre-move state: drop an unfinished cross device copy, clear this call's
          // destination, put back an entry that was staged aside and prune the parents it created. A rollback
          // that fails in turn is reported together with the cause and names the path the staged entry is
          // recoverable from.
          if (
            !(await fs
              .rm(copy, { recursive: true, force: true })
              .then(() => fs.rm(destination.real, { recursive: true, force: true }))
              .then(() => (exists ? fs.rename(aside, destination.real) : undefined))
              .then(() => prune())
              .then(
                () => true,
                () => false,
              ))
          )
            throw new Error(
              `Moving ${from} to ${to} failed and what it changed could not be put back${
                exists ? `; the entry the destination held is at ${aside}` : ""
              }: ${cause.message}`,
              { cause },
            )
          throw cause
        })

      // Publish edited, then the source unlink and the destination add, using the caller visible spellings
      // that existing listeners are keyed on.
      await Bus.publish(File.Event.Edited, { file: destination.full })
      await Bus.publish(FileWatcher.Event.Updated, { file: source.full, event: "unlink" })
      await Bus.publish(FileWatcher.Event.Updated, { file: destination.full, event: "add" })

      // Record the destination for a later edit and touch only a file in the language server. touchFile waits
      // for diagnostics, but this tool neither queries nor appends them.
      FileTime.read(ctx.sessionID, destination.full)
      if (!directory) await LSP.touchFile(destination.full, true)

      // Delete the staged destination now that the move is committed. A failure is surfaced, because leaving
      // replaced content beside the new destination is incomplete cleanup, and it is surfaced only after the
      // events above, so a relocation that is already on disk is never left unannounced.
      if (exists)
        await fs.rm(aside, { recursive: true, force: true }).catch((cause: Error) => {
          throw new Error(
            `Moved ${from} to ${to}, but what it replaced could not be removed from ${aside}: ${cause.message}`,
            { cause },
          )
        })

      return {
        title: `${from} -> ${to}`,
        metadata: {
          source: source.full,
          destination: destination.full,
          directory,
          overwritten: exists,
        },
        output: directory ? `Moved directory ${from} to ${to}` : `Moved file ${from} to ${to}`,
      }
    })
  },
})
