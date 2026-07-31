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
import { Instance } from "../project/instance"
import { LSP } from "../lsp"

/**
 * Relocates exactly one filesystem entry -- a single file, or a single directory together with its
 * whole subtree -- per invocation, in a fixed order: resolve, canonicalize, guard, consent, lock,
 * revalidate, stage, commit, announce, report.
 *
 * This exists so the model never has to shell out to `mv`. A shell invocation would be gated by the
 * coarse `bash` permission instead of the targeted `edit` permission that governs every other file
 * mutation, and it would publish nothing on the event bus, leaving the editor and the language
 * server unaware that the entry changed location.
 *
 * Three properties of the operation drive the shape of the code, and each of them is load bearing.
 *
 * A path is not an identity. A link anywhere in an ancestor chain makes two spellings reach one
 * location, so every endpoint is canonicalized before it is consented to, compared, locked or
 * written: consent recorded against a spelling would otherwise authorize a directory the operation
 * never touches, while the write followed the link. Both endpoints are canonicalized and both are
 * locked, because a move mutates the source as well as the destination.
 *
 * Part of the invalid input is reported as success. Renaming a path onto itself is a silent no-op and
 * renaming over an existing destination silently replaces it, so neither can be detected after the
 * fact; and an overlapping pair destroys what it was asked to move before the commit is reached, since
 * setting aside an overwrite destination that contains, or sits inside, the source carries it away.
 * All of it is therefore pre-checked, on both spellings, with segment-aware containment and with the
 * device and inode pair for the aliases a string comparison cannot see -- then checked once more under
 * the locks of both endpoints, since the first pass ran before a permission prompt that can block for
 * an arbitrarily long time, during which either endpoint can change underneath.
 *
 * A relocation cannot be rolled back once anything has been destroyed. So nothing is: the destination
 * name is claimed atomically, the source is staged into the destination's own parent, an existing
 * destination is set aside under a backup rather than removed, the commit is a single rename, and the
 * source, the backup and any parent directory this call created are only dropped -- or put back -- once
 * the outcome is known.
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
    // would then set aside and replace with the single entry it was asked to move.
    if (!params.source.trim()) throw new Error("Source path must not be empty")
    if (!params.destination.trim()) throw new Error("Destination path must not be empty")

    // Both endpoints are resolved and lexically normalized up front. An absolute endpoint passes
    // through and a relative one is joined onto the project directory, which is the rule the read and
    // write tools apply; normalizing on top of that is what stops `dir/./file` and `dir/file` from
    // naming one entry while comparing as two.
    const source = path.resolve(Instance.directory, params.source)
    const destination = path.resolve(Instance.directory, params.destination)

    // Absence is the only probe outcome that may be inferred from a failure, and only from the two
    // codes that mean nothing is there. A denied traversal, a symlink loop, a stale handle or an I/O
    // error means the probe never completed, and reading that as absence would decide overwrite,
    // overlap and identity from a value that nothing established.
    const absent = (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return undefined
      throw err
    }

    // lstat describes the entry rather than whatever it points at, which is the semantic this tool
    // moves by: a link travels as the link itself, so a link whose target is missing still exists
    // here, and a link to a directory is not a directory. The `Filesystem` probes stat through the
    // link, so they would instead report the first as absent and the second as a directory.
    const stat = (p: string) => fs.lstat(p).catch(absent)

    // Resolves a directory chain, dereferencing every link in it, and puts back the components that
    // do not exist yet, so a path can be canonicalized before anything has been created at it.
    const chain = async (dir: string): Promise<string> => {
      const real = await fs.realpath(dir).catch(absent)
      if (real) return real
      const parent = path.dirname(dir)
      if (parent === dir) return dir
      return path.join(await chain(parent), path.basename(dir))
    }

    // The path the filesystem will really act on, which is the only thing worth consenting to,
    // comparing or locking: every ancestor link is resolved, while an endpoint that is itself a link
    // stays as written, because this tool relocates the link and not its target. A link anywhere in
    // the chain is what makes this necessary, since `link/entry` and the entry under the directory
    // `link` points at are one location reached by two spellings, and consent recorded against a
    // spelling says nothing about the location.
    const identity = async (p: string) => {
      const entry = await stat(p)
      const real = entry && !entry.isSymbolicLink() ? await fs.realpath(p).catch(absent) : undefined
      return real ?? path.join(await chain(path.dirname(p)), path.basename(p))
    }
    const locate = async () => ({ source: await identity(source), destination: await identity(destination) })
    const canonical = await locate()

    // `path.relative` is not a containment test on its own: a sibling named `..cache` answers with a
    // leading `..` without leaving the parent, and across Windows drives it answers with an absolute
    // path, which the repository's lexical helper reads as contained. Containment here therefore
    // demands an answer that is relative and that carries no `..` segment of its own.
    const within = (parent: string, child: string) => {
      if (parent === child) return true
      const rel = path.relative(parent, child)
      return rel !== "" && !path.isAbsolute(rel) && !rel.split(path.sep).includes("..")
    }

    // Darwin and Windows compare filenames without regard to case, and Darwin also without regard to
    // Unicode composition, so on those platforms two spellings that differ only that way name one
    // entry, and the checks that decide what gets destroyed have to read them as one. Folded
    // spellings are used only where treating two of them as one is the safe answer, never to widen
    // what counts as inside the project.
    const fold = (p: string) =>
      process.platform === "darwin" || process.platform === "win32" ? p.normalize("NFC").toLowerCase() : p

    // Neither endpoint may be the project root itself, and the two may neither name one entry nor nest
    // inside one another. All of it is fatal and none of it is visible afterwards: `.`, `./`, a bare
    // separator and the project path spelled out in full all resolve to the root, renaming a path onto
    // itself succeeds as a silent no-op, and setting aside an overlapping destination carries away the
    // source, or part of the source subtree, before the rename runs. Applied to the requested spelling
    // and to the canonical one, then once more under the locks before anything is written.
    const guard = (c: { source: string; destination: string }) => {
      if (c.source === Instance.directory || c.source === Instance.worktree)
        throw new Error(`Source must not be the project root: ${c.source}`)
      if (c.destination === Instance.directory || c.destination === Instance.worktree)
        throw new Error(`Destination must not be the project root: ${c.destination}`)
      if (fold(c.source) === fold(c.destination))
        throw new Error(`Source and destination are the same path: ${c.source}`)
      if (within(fold(c.source), fold(c.destination)) || within(fold(c.destination), fold(c.source)))
        throw new Error(`Source and destination overlap: one of ${c.source} and ${c.destination} contains the other`)
    }
    guard({ source, destination })
    guard(canonical)

    // A move unlinks the entry from the source parent and creates it in the destination parent, so
    // both endpoints are gated, on their canonical spelling, because consent collected for a spelling
    // that a link aliases would name a directory the operation never touches. The shared guard is
    // passed no options, which scopes consent to each parent directory -- precisely the scope this
    // operation mutates. That guard decides containment lexically though, which reads a path on a
    // second filesystem root -- another Windows drive, a UNC share -- as contained and then skips it
    // silently, so an endpoint the stricter test above places outside the project is asked for here
    // instead, on the same parent glob the shared guard would have used.
    const boundary = async (p: string) => {
      await assertExternalDirectory(ctx, p)
      if (within(Instance.directory, p)) return
      if (Instance.worktree !== path.parse(Instance.worktree).root && within(Instance.worktree, p)) return
      if (!Instance.containsPath(p)) return
      const glob = path.join(path.dirname(p), "*")
      await ctx.ask({
        permission: "external_directory",
        patterns: [glob],
        always: [glob],
        metadata: {
          filepath: p,
          parentDir: path.dirname(p),
        },
      })
    }
    await boundary(canonical.source)
    await boundary(canonical.destination)

    // The device and inode pair is the only thing that settles whether two spellings name one entry
    // once both exist, and it is what catches the hard link, the bind mount and the case or
    // composition alias that a string comparison cannot see.
    const same = (a?: { dev: number; ino: number }, b?: { dev: number; ino: number }) =>
      !!a && !!b && a.dev === b.dev && a.ino === b.ino

    // Probed after consent, so an unauthorized path is never told whether it exists, and repeated
    // under the locks, because a probe that decides whether an overwrite destroys something is only as
    // current as the moment it ran.
    const inspect = async (c: { source: string; destination: string }) => {
      const entry = await stat(c.source)
      if (!entry) throw new Error(`File or directory not found: ${c.source}`)
      const existing = await stat(c.destination)
      if (same(entry, existing)) throw new Error(`Source and destination are the same path: ${c.source}`)
      if (existing && !params.overwrite)
        throw new Error(`Destination already exists: ${c.destination}. Pass overwrite: true to replace it`)
      return entry
    }
    await inspect(canonical)

    const from = path.relative(Instance.worktree, canonical.source)
    const to = path.relative(Instance.worktree, canonical.destination)

    // Asked after validation, so rejected input fails without prompting, and before the first
    // filesystem call, so a denial leaves both endpoints byte identical. The destination is the sole
    // pattern, which is the request the write tool makes for a file it is about to rewrite, so a
    // relocation is governed by the same targeted `edit` permission as every other mutation rather
    // than by a key of its own. It is named by its canonical spelling, because a pattern matched
    // against a spelling an ancestor link aliases would describe a directory the write never reaches.
    // An `edit` no rule mentions prompts rather than allows, and a deny raises before anything moves.
    await ctx.ask({
      permission: "edit",
      patterns: [to],
      always: ["*"],
      metadata: {
        source: canonical.source,
        destination: canonical.destination,
      },
    })

    // Both endpoints are locked, because a move mutates both, and in sorted order so two concurrent
    // moves can never hold one lock each while waiting for the other. The two keys are known to differ,
    // because an equal pair was refused above, so the nested acquisition cannot block on itself.
    const locks = [canonical.source, canonical.destination].sort()
    return FileTime.withLock(locks[0], () =>
      FileTime.withLock(locks[1], async () => {
        // Everything above ran before a permission prompt that can block for an arbitrarily long time,
        // so the identities are established again now that both endpoints are held. A changed identity
        // means an ancestor was swapped underneath the pending consent, and the locks are held on the
        // identities that were authorized: the new pair is therefore neither authorized nor serialized,
        // so nothing is touched and the model is told to ask again, which re-runs the whole sequence
        // against whatever the paths now mean.
        const current = await locate()
        if (current.source !== canonical.source || current.destination !== canonical.destination)
          throw new Error(
            `Source or destination changed while permission was pending: ${canonical.source} -> ${canonical.destination}. Nothing was moved, retry the move`,
          )

        // The checks that decide what gets destroyed are repeated here, immediately before the first
        // write, because a check is only as current as the moment it ran. The entry is the one the move
        // will carry, so the result is described from this pass rather than from the earlier one.
        guard(current)
        const entry = await inspect(current)
        const directory = entry.isDirectory()

        // A rename into a missing parent fails with ENOENT, so the chain is created first. Recursive
        // creation is safe on directories that already exist, and it reports the topmost directory it
        // had to create, which is all that a failed move has to take back.
        const created = await fs.mkdir(path.dirname(current.destination), { recursive: true })

        // Removes only directories that are still empty, deepest first, and only within the chain this
        // call created, so a parent built for a relocation that then failed does not outlive it while
        // anything a concurrent writer put inside stops the walk instead of being deleted.
        const prune = async (dir: string): Promise<void> => {
          if (!created || !within(created, dir)) return
          if (
            !(await fs.rmdir(dir).then(
              () => true,
              () => false,
            ))
          )
            return
          return prune(path.dirname(dir))
        }

        // The destination name is claimed with a plain mkdir, which is atomic and fails with EEXIST
        // over a file, a directory or even a dangling link. That is what makes the overwrite decision
        // safe: a probe answers for the instant it ran and a staging copy can take seconds, whereas
        // this holds the name for the whole relocation, so a destination that appears in the meantime
        // can no longer be replaced without consent. The claim is recorded by identity, because it may
        // only ever be taken back while it is still the very directory this call created.
        const taken = await fs.mkdir(current.destination).then(
          () => false,
          async (err: NodeJS.ErrnoException) => {
            if (err.code !== "EEXIST") {
              await prune(path.dirname(current.destination))
              throw err
            }
            return true
          },
        )
        if (taken && !params.overwrite) {
          await prune(path.dirname(current.destination))
          throw new Error(`Destination already exists: ${current.destination}. Pass overwrite: true to replace it`)
        }
        const claim = taken ? undefined : await stat(current.destination)

        // Nothing is destroyed before the relocation is known to have succeeded. The source is first
        // moved aside into the destination's own parent, so committing it is a same-device rename that
        // cannot fail for want of space or a device boundary, and an existing destination is set aside
        // under a sibling of itself rather than removed, so a commit that still fails can put it back.
        // The source and that backup are dropped only once the destination is committed.
        const stage = `${current.destination}.${crypto.randomUUID()}.opencode-move`
        const backup = `${current.destination}.${crypto.randomUUID()}.opencode-backup`

        // Takes back whatever the commit managed to do, reading the filesystem rather than a ledger:
        // the stage is the source itself when the source is gone and a discardable copy when it is not,
        // the claimed name goes only if it is still the empty directory this call created, and a set
        // aside destination returns only if nothing has taken its place.
        const revert = async () => {
          const staged = !!(await stat(stage))
          const gone = !(await stat(current.source))
          if (staged && gone) await fs.rename(stage, current.source)
          if (staged && !gone) await fs.rm(stage, { recursive: true, force: true })
          if (same(claim, await stat(current.destination))) await fs.rmdir(current.destination).catch(() => undefined)
          if ((await stat(backup)) && !(await stat(current.destination))) await fs.rename(backup, current.destination)
          await prune(path.dirname(current.destination))
        }

        const failure = await (async () => {
          // A rename carries a whole directory subtree atomically on one device, but fails with EXDEV
          // across a device boundary, where a recursive copy is the equivalent. That copy replaces
          // nothing, and it reproduces a link as a link with its target written verbatim, so an entry
          // still travels as itself either way, matching `mv`.
          const copied = await fs.rename(current.source, stage).then(
            () => false,
            async (err: NodeJS.ErrnoException) => {
              if (err.code !== "EXDEV") throw err
              await fs.cp(current.source, stage, {
                recursive: true,
                force: false,
                errorOnExist: true,
                verbatimSymlinks: true,
              })
              return true
            },
          )
          if (taken) await fs.rename(current.destination, backup)
          if (!taken) await fs.rmdir(current.destination)
          await fs.rename(stage, current.destination)
          if (copied) await fs.rm(current.source, { recursive: true, force: true })
          if (taken) await fs.rm(backup, { recursive: true, force: true })
        })().then(
          () => undefined,
          (err: unknown) => err,
        )
        if (failure) {
          await revert()
          throw failure
        }

        // Editors learn that the content is now authoritative at the destination, then that the source
        // path is gone and the destination path is new. This reuses the existing event triple rather
        // than introducing a dedicated relocation event.
        await Bus.publish(File.Event.Edited, { file: current.destination })
        await Bus.publish(FileWatcher.Event.Updated, { file: current.source, event: "unlink" })
        await Bus.publish(FileWatcher.Event.Updated, { file: current.destination, event: "add" })

        // Recording the read stops a subsequent edit of the relocated entry from demanding a fresh
        // read. Only files are opened in the language server, since a directory is not a document,
        // and no diagnostics are collected because a move leaves the content byte identical.
        FileTime.read(ctx.sessionID, current.destination)
        if (!directory) await LSP.touchFile(current.destination, true)

        return {
          title: `${from} -> ${to}`,
          metadata: {
            source: current.source,
            destination: current.destination,
            directory,
            overwritten: taken,
          },
          output: directory ? `Moved directory ${from} to ${to}` : `Moved file ${from} to ${to}`,
        }
      }),
    )
  },
})
