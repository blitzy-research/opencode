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
    // would otherwise broaden an external_directory grant past the path the user approved.
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
    // 1. Resolve both endpoints. Each is resolved against the project directory the way the write tool
    // resolves its own, and that spelling is kept as `full`: it is what the caller asked for and what every
    // reported and keyed surface below uses, so a later read or edit of the same spelling shares this tool's
    // file times, locks and events. Joining only collapses "." and ".." segments though, so a link in a
    // parent would still send the kernel somewhere other than the spelling suggests. Walking down from the
    // filesystem root and canonicalizing every prefix that already exists gives `real`, the entry the kernel
    // will actually touch, which is what the boundary decision and every mutation below use. The final name
    // is attached again untouched, so a link still travels as the link rather than as its target.
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
    // A parent can carry a glob character of its own even though the schema refused one in the spelling, and
    // the guard below would put that character straight into the pattern it asks to remember, where it would
    // go on matching siblings the user never saw. Resolution is not finished until both endpoints are literal
    // paths.
    if (/[*?]/.test(source.real)) throw new Error(`Source resolves to a path containing * or ?: ${source.real}`)
    if (/[*?]/.test(destination.real))
      throw new Error(`Destination resolves to a path containing * or ?: ${destination.real}`)

    // 2. Guard both endpoints for the project boundary, source first, with the shared helper and no options:
    // a move unlinks the entry from one parent and creates it in the other, so a directory hint would
    // authorize the moved contents instead of the scope that actually changes. Guarding ahead of every probe
    // means an unauthorized path prompts for consent before this tool discloses whether it exists. Each
    // endpoint is guarded as the caller spelled it, and again as the kernel reaches it whenever a link makes
    // those two differ, because the second one is what the mutations below touch.
    await assertExternalDirectory(ctx, source.full)
    if (source.real !== source.full) await assertExternalDirectory(ctx, source.real)
    await assertExternalDirectory(ctx, destination.full)
    if (destination.real !== destination.full) await assertExternalDirectory(ctx, destination.real)

    // 3. Refuse an equal pair. Renaming a path onto itself succeeds as a silent no-op, so this is refused
    // here or not at all, and the resolved identities are what decide it, which catches one absolute and one
    // relative spelling as well as two spellings that meet through a link.
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
    if (roots.includes(source.real)) throw new Error(`Source must not be the project root: ${source.full}`)
    if (roots.includes(destination.real))
      throw new Error(`Destination must not be the project root: ${destination.full}`)
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

    // 4. The source must exist. The stat based helper is the probe, because an existence check that opens the
    // path reports false for a real directory. A stat follows a link though, so an entry whose target is gone
    // reads as missing there while it is an entry of its own that this tool relocates; the entry's own stat
    // answers for that case, and identifies the entry besides.
    const stat = await fs.lstat(source.real).catch(() => undefined)
    if (!(await Filesystem.exists(source.real)) && !stat) throw new Error(`File or directory not found: ${source.full}`)
    // The kind is decided by the entry itself, so a link to a directory is relocated as the single link it
    // is, and the shared helper classifies everything that is not a link.
    const directory = stat?.isSymbolicLink() === false && (await Filesystem.isDir(source.real))

    // 5. The destination must not exist unless this call may replace it, because fs.rename replaces one
    // silently and the kernel offers no protection of its own. The probe is retained: it also decides the
    // removal further down and the flag this call reports.
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

    // 6. Ask for the destination: one edit request on the existing permission key, in the shape the write
    // tool uses, made after validation so invalid input never prompts and strictly before the first mutation
    // so a denial leaves the filesystem untouched.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source: source.full,
        destination: destination.full,
      },
    })

    // 7. Serialize on the destination, as the file time module prescribes for every tool that overwrites an
    // existing file, keyed on the spelling the caller used so a later edit of that spelling waits here.
    return FileTime.withLock(destination.full, async () => {
      // A link in a parent can be repointed, or a real parent swapped for a link, while the permission
      // request is pending, which would aim everything below at entries other than the pair that was
      // consented for. Every parent that already exists is canonicalized once more and must still answer
      // with the parent that was authorized; one that does not exist yet cannot have been substituted.
      // Nothing has been created at this point, so this refusal leaves the filesystem as the call found it.
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

      // 8. Create the destination's parent, because a rename into a missing one fails with ENOENT. mkdir
      // answers with the topmost directory it had to create, and the chain from there down to the parent is
      // kept, deepest first, so a failure below can take back exactly what this call added and nothing else.
      const parents = await fs.mkdir(path.dirname(destination.real), { recursive: true }).then((created) =>
        created
          ? path
              .relative(created, path.dirname(destination.real))
              .split(path.sep)
              .filter((part) => part !== "")
              .map((_, index, parts) => path.join(created, ...parts.slice(0, parts.length - index)))
              .concat(created)
          : [],
      )

      // 9, begun. Take the destination, which is where the removal of what it held starts; that removal is
      // completed below, once the relocation is committed. Nothing this call found is destroyed before the
      // relocation has succeeded. A destination that must stay free is held with an exclusive create of the
      // source's own kind, because a rename only ever replaces an entry of its own kind, and that reservation
      // is what makes a writer arriving after the probe above lose the race instead of being displaced
      // silently. A destination that is being replaced is moved aside instead, so a relocation that fails
      // afterwards can put it back untouched.
      const aside = `${destination.real}.opencode-move-${Bun.randomUUIDv7()}`
      if (!exists)
        await (
          directory ? fs.mkdir(destination.real) : fs.open(destination.real, "wx").then((handle) => handle.close())
        ).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err
          // The entry in the way belongs to another writer and is left alone, and so is the directory it
          // sits in: rmdir refuses one that is not empty, so walking back up stops at the first directory
          // that is still in use and only what this call added and nobody else touched comes down.
          await parents.reduce(
            (prior, dir) =>
              prior.then((going) =>
                going
                  ? fs.rmdir(dir).then(
                      () => true,
                      () => false,
                    )
                  : false,
              ),
            Promise.resolve(true),
          )
          throw new Error(`Destination already exists: ${destination.full}. Pass overwrite: true to replace it`)
        })
      if (exists) await fs.rename(destination.real, aside)

      // 10. Rename, which carries a whole directory subtree atomically on one device and relocates a
      // symbolic link as the link itself rather than as its target, matching `mv`.
      await fs
        .rename(source.real, destination.real)
        .catch(async (err: NodeJS.ErrnoException) => {
          // Another call can relocate the source inside the window above, which surfaces as ENOENT and is
          // reported as the missing source it really is. Across a device boundary the rename fails with
          // EXDEV instead, where a recursive copy followed by the removal of the source is the equivalent.
          // That copy keeps every link verbatim, and force lets it land on the entry this call is holding.
          if (err.code === "ENOENT" && !(await fs.lstat(source.real).catch(() => undefined)))
            throw new Error(`File or directory not found: ${source.full}`)
          if (err.code !== "EXDEV") throw err
          await fs
            .cp(source.real, destination.real, {
              recursive: true,
              force: true,
              dereference: false,
              verbatimSymlinks: true,
            })
            .then(() => fs.rm(source.real, { recursive: true, force: true }))
        })
        .catch(async (cause: Error) => {
          // Put back everything this call changed before the failure is reported. Whatever stands at the
          // destination now was put there by this call and by nothing else, because it either holds its own
          // reservation or moved the previous entry aside, so removing it costs the user nothing; the entry
          // that was moved aside then goes back where it was, and the empty directories this call created
          // come down again. A rollback that fails in turn is reported together with the failure that caused
          // it rather than in place of it, and it names the path the old destination is recoverable from.
          if (
            !(await fs
              .rm(destination.real, { recursive: true, force: true })
              .then(() => (exists ? fs.rename(aside, destination.real) : undefined))
              .then(() =>
                parents.reduce(
                  (prior, dir) =>
                    prior.then((going) =>
                      going
                        ? fs.rmdir(dir).then(
                            () => true,
                            () => false,
                          )
                        : false,
                    ),
                  Promise.resolve(true),
                ),
              )
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

      // 9, concluded. Remove what the destination held, recursively, now that the relocation is committed.
      // That removal is what the explicit overwrite contract asks for, and it is why a directory destination
      // that still has contents can be replaced at all rather than failing with ENOTEMPTY. Deferring it to
      // here instead of clearing the destination ahead of the rename is what made the rollback above able to
      // put the entry back. It cannot be dropped quietly either, because a destination whose former contents
      // still stand beside it is not the outcome this call reports.
      if (exists)
        await fs.rm(aside, { recursive: true, force: true }).catch((cause: Error) => {
          throw new Error(
            `Moved ${from} to ${to}, but what it replaced could not be removed from ${aside}: ${cause.message}`,
            { cause },
          )
        })

      // 11. Announce the change: editors learn that the content is now authoritative at the destination,
      // then that the source path is gone and the destination path is new. The existing event triple is
      // reused rather than a relocation event of its own, and the paths are the spellings the caller used, so
      // a listener keyed on them recognizes the entry it already knows.
      await Bus.publish(File.Event.Edited, { file: destination.full })
      await Bus.publish(FileWatcher.Event.Updated, { file: source.full, event: "unlink" })
      await Bus.publish(FileWatcher.Event.Updated, { file: destination.full, event: "add" })

      // 12. Record the destination as read for the session, which is what a later edit of it relies on, and
      // touch only a file in the language server, since a directory is not a document. Diagnostics are
      // neither requested nor appended, because a move leaves the content byte identical.
      FileTime.read(ctx.sessionID, destination.full)
      if (!directory) await LSP.touchFile(destination.full, true)

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
