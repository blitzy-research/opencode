import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { MoveTool } from "../../src/tool/move"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { Bus } from "../../src/bus"
import { File } from "../../src/file"
import { FileWatcher } from "../../src/file/watcher"
import { FileTime } from "../../src/file/time"

// The tool renders its title, output and edit pattern relative to Instance.worktree, and a non-git project
// reports "/" there, so every fixture below is git backed to keep the expected strings literal.
const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.move", () => {
  test("renames a file within the project and removes the source", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const result = await move.execute({ source: "a.txt", destination: "b.txt" }, ctx)
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).exists()).toBe(false)
        expect(result.title).toBe("a.txt -> b.txt")
        expect(result.output).toBe("Moved file a.txt to b.txt")
        // Asserted field by field because Tool.define injects a truncated flag into every metadata object.
        expect(result.metadata.source).toBe(path.join(tmp.path, "a.txt"))
        expect(result.metadata.destination).toBe(path.join(tmp.path, "b.txt"))
        expect(result.metadata.directory).toBe(false)
        expect(result.metadata.overwritten).toBe(false)
        // The destination is recorded as read for the session, which is what a later edit of it relies on.
        expect(FileTime.get(ctx.sessionID, path.join(tmp.path, "b.txt"))).toBeInstanceOf(Date)
        // A symbolic link is an entry of its own, so even a dangling one moves, and it arrives as the link
        // itself rather than as whatever it points at.
        await fs.symlink("ghost.txt", path.join(tmp.path, "link.txt"))
        const link = await move.execute({ source: "link.txt", destination: "moved.txt" }, ctx)
        expect(await fs.lstat(path.join(tmp.path, "moved.txt")).then((stat) => stat.isSymbolicLink())).toBe(true)
        expect(await fs.readlink(path.join(tmp.path, "moved.txt"))).toBe("ghost.txt")
        expect(await fs.readdir(tmp.path)).not.toContain("link.txt")
        expect(link.output).toBe("Moved file link.txt to moved.txt")
        expect(link.metadata.directory).toBe(false)
      },
    })
  })

  test("moves a file into a subdirectory that does not exist yet", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        // A rename into a missing parent fails with ENOENT, so arriving here proves the recursive mkdir ran.
        const nested = path.join("sub", "nested", "b.txt")
        const result = await move.execute({ source: "a.txt", destination: nested }, ctx)
        expect(await Bun.file(path.join(tmp.path, nested)).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).exists()).toBe(false)
        expect(result.title).toBe(`a.txt -> ${nested}`)
        expect(result.output).toBe(`Moved file a.txt to ${nested}`)
        // A name the filesystem cannot hold refuses the destination only once those parents exist, and a call
        // that relocated nothing leaves nothing behind, so the whole chain it created comes back down.
        const events: string[] = []
        const unwatch = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
          events.push(`${event.properties.event}:${event.properties.file}`)
        })
        const refused = await move
          .execute({ source: nested, destination: path.join("p1", "p2", "p3", "z".repeat(300) + ".txt") }, ctx)
          .then(
            () => "moved",
            (err: NodeJS.ErrnoException) => err.code,
          )
        unwatch()
        expect(refused).toBe("ENAMETOOLONG")
        expect(await fs.readdir(tmp.path)).not.toContain("p1")
        expect(events).toEqual([])
        expect(await Bun.file(path.join(tmp.path, nested)).text()).toBe("hello world")
        // Only what this call added comes down: a destination another writer takes inside the same new chain
        // keeps that chain, because pruning stops at a directory which is still in use.
        const taken = await move
          .execute(
            { source: nested, destination: path.join("e1", "e2", "taken.txt") },
            {
              ...ctx,
              ask: async () => {
                await Bun.write(path.join(tmp.path, "e1", "e2", "taken.txt"), "another writer")
              },
            },
          )
          .then(
            () => "moved",
            (err: Error) => err.message,
          )
        expect(taken).toContain("Destination already exists:")
        expect(await Bun.file(path.join(tmp.path, "e1", "e2", "taken.txt")).text()).toBe("another writer")
        expect(await Bun.file(path.join(tmp.path, nested)).text()).toBe("hello world")
      },
    })
  })

  test("requests edit permission for the destination path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await move.execute({ source: "a.txt", destination: "b.txt" }, testCtx)
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("edit")
        expect(requests[0].patterns).toEqual(["b.txt"])
        expect(requests[0].always).toEqual(["*"])
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("requests external_directory permission when the source is outside the project", async () => {
    await using outer = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(outer.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        const source = path.join(outer.path, "a.txt")
        await move.execute({ source, destination: "b.txt" }, testCtx)
        // The guard is asked without a kind hint, so the glob covers the endpoint's parent directory.
        const expected = path.join(path.dirname(source), "*")
        const req = requests.find((r) => r.permission === "external_directory")
        expect(req).toBeDefined()
        expect(req!.patterns).toEqual([expected])
        expect(req!.always).toEqual([expected])
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("hello world")
        // Spelling that same outside directory through a link inside the project reaches the same entries, so
        // it is authorized where they really live rather than treated as part of the project.
        await fs.symlink(outer.path, path.join(tmp.path, "out"))
        await Bun.write(path.join(outer.path, "secret.txt"), "top secret")
        const escape = await move.execute(
          { source: path.join("out", "secret.txt"), destination: "stolen.txt" },
          testCtx,
        )
        expect(requests.map((r) => r.permission)).toEqual(["external_directory", "edit", "external_directory", "edit"])
        expect(requests.filter((r) => r.permission === "external_directory").map((r) => r.patterns)).toEqual([
          [expected],
          [expected],
        ])
        // The physical source is outside the project, while metadata keeps the caller's spelling.
        expect(escape.metadata.source).toBe(path.join(tmp.path, "out", "secret.txt"))
        expect(await fs.readdir(outer.path)).not.toContain("secret.txt")
        expect(await Bun.file(path.join(tmp.path, "stolen.txt")).text()).toBe("top secret")
      },
    })
  })

  test("requests external_directory permission when the destination is outside the project", async () => {
    await using outer = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        const destination = path.join(outer.path, "b.txt")
        await move.execute({ source: "a.txt", destination }, testCtx)
        const expected = path.join(path.dirname(destination), "*")
        const req = requests.find((r) => r.permission === "external_directory")
        expect(req).toBeDefined()
        expect(req!.patterns).toEqual([expected])
        expect(req!.always).toEqual([expected])
        expect(await Bun.file(destination).text()).toBe("hello world")
        // A destination spelled through a link inside the project lands outside it, so consent is asked for
        // the directory that really receives the entry.
        await fs.symlink(outer.path, path.join(tmp.path, "out"))
        await Bun.write(path.join(tmp.path, "c.txt"), "leaking content")
        const leak = await move.execute({ source: "c.txt", destination: path.join("out", "leaked.txt") }, testCtx)
        expect(requests.map((r) => r.permission)).toEqual(["external_directory", "edit", "external_directory", "edit"])
        expect(requests.filter((r) => r.permission === "external_directory").map((r) => r.patterns)).toEqual([
          [expected],
          [expected],
        ])
        // The entry lands outside the project, while metadata keeps the caller's destination spelling.
        expect(leak.metadata.destination).toBe(path.join(tmp.path, "out", "leaked.txt"))
        expect(await Bun.file(path.join(outer.path, "leaked.txt")).text()).toBe("leaking content")
      },
    })
  })

  test("throws when the source does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await expect(move.execute({ source: "missing.txt", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "File or directory not found:",
        )
        expect(await Bun.file(path.join(tmp.path, "b.txt")).exists()).toBe(false)
        await expect(move.execute({ source: "", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        await expect(move.execute({ source: "a.txt", destination: "" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        // A glob character is refused by the schema in either position, because the destination becomes a
        // remembered permission pattern and one entry moves per call.
        await expect(move.execute({ source: "*.txt", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        await expect(move.execute({ source: "a.txt", destination: "b?.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        // A clean spelling can still resolve through a link into a real directory whose own name holds a glob
        // character, and that is refused too, reporting the spelling that was passed rather than the resolved
        // path the caller has not been granted yet.
        await fs.mkdir(path.join(tmp.path, "star*dir"))
        await Bun.write(path.join(tmp.path, "star*dir", "inner.txt"), "inner")
        await fs.symlink(path.join(tmp.path, "star*dir"), path.join(tmp.path, "plain"))
        const resolved = await move
          .execute({ source: path.join("plain", "inner.txt"), destination: "c.txt" }, testCtx)
          .then(
            () => "moved",
            (err: Error) => err.message,
          )
        expect(resolved).toContain("Source resolves to a path containing * or ?:")
        expect(resolved).toContain(path.join(tmp.path, "plain", "inner.txt"))
        expect(resolved).not.toContain("star*dir")
        await expect(
          move.execute({ source: "a.txt", destination: path.join("plain", "moved.txt") }, testCtx),
        ).rejects.toThrow("Destination resolves to a path containing * or ?:")
        expect(await Bun.file(path.join(tmp.path, "star*dir", "inner.txt")).text()).toBe("inner")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(requests).toEqual([])
        // Two calls competing for one source: only one of them can relocate it, and the one that loses
        // reports the missing source rather than a raw errno while leaving its own destination untouched.
        await Bun.write(path.join(tmp.path, "one.txt"), "one")
        await Bun.write(path.join(tmp.path, "keep.txt"), "keep")
        await Bun.write(path.join(tmp.path, "other.txt"), "other")
        const outcomes = await Promise.all([
          move.execute({ source: "one.txt", destination: "keep.txt", overwrite: true }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "one.txt", destination: "other.txt", overwrite: true }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome !== "moved")).toContain("File or directory not found:")
        expect(await Bun.file(path.join(tmp.path, "one.txt")).exists()).toBe(false)
        // Exactly one destination receives the source; rollback preserves the entry the losing one held.
        const survivors = [
          await Bun.file(path.join(tmp.path, "keep.txt")).text(),
          await Bun.file(path.join(tmp.path, "other.txt")).text(),
        ]
        expect(survivors.filter((text) => text === "one")).toHaveLength(1)
        expect(survivors.filter((text) => text === "keep" || text === "other")).toHaveLength(1)
        expect((await fs.readdir(tmp.path)).filter((name) => name.includes("opencode-move"))).toEqual([])
        // Competing moves onto free destinations must remove the losing reservation, not leave an empty path.
        await Bun.write(path.join(tmp.path, "two.txt"), "two")
        const fresh = await Promise.all([
          move.execute({ source: "two.txt", destination: "alpha.txt" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "two.txt", destination: "beta.txt" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(fresh.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(fresh.find((outcome) => outcome !== "moved")).toContain("File or directory not found:")
        expect(await fs.readdir(tmp.path)).toEqual(expect.arrayContaining(["keep.txt", "other.txt"]))
        const landed = (await fs.readdir(tmp.path)).filter((name) => name === "alpha.txt" || name === "beta.txt")
        expect(landed).toHaveLength(1)
        expect(await Bun.file(path.join(tmp.path, landed[0]!)).text()).toBe("two")
      },
    })
  })

  test("throws when the destination already exists and overwrite is not set", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Bun.write(path.join(tmp.path, "b.txt"), "existing")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await expect(move.execute({ source: "a.txt", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "Destination already exists:",
        )
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("existing")
        // A dangling link is an entry of its own, so it is protected without being followed.
        await fs.symlink("ghost.txt", path.join(tmp.path, "link.txt"))
        await expect(move.execute({ source: "a.txt", destination: "link.txt" }, testCtx)).rejects.toThrow(
          "Destination already exists:",
        )
        expect(await fs.readlink(path.join(tmp.path, "link.txt"))).toBe("ghost.txt")
        // rename can replace an empty directory silently, so overwrite protection covers directory destinations.
        await Bun.write(path.join(tmp.path, "dir", "keep.txt"), "kept content")
        await fs.mkdir(path.join(tmp.path, "empty"))
        await expect(move.execute({ source: "dir", destination: "empty" }, testCtx)).rejects.toThrow(
          "Destination already exists:",
        )
        expect(await fs.readdir(path.join(tmp.path, "empty"))).toEqual([])
        expect(await Bun.file(path.join(tmp.path, "dir", "keep.txt")).text()).toBe("kept content")
        expect(requests).toEqual([])
        // Two moves onto one destination are serialized on it, so the second one sees the first and refuses
        // rather than replacing it silently.
        await Bun.write(path.join(tmp.path, "one.txt"), "one")
        await Bun.write(path.join(tmp.path, "two.txt"), "two")
        const outcomes = await Promise.all([
          move.execute({ source: "one.txt", destination: "d.txt" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "two.txt", destination: "d.txt" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome !== "moved")).toContain("Destination already exists:")
        const rest = (await fs.readdir(tmp.path)).filter((name) => name === "one.txt" || name === "two.txt")
        expect(rest).toHaveLength(1)
        expect(await Bun.file(path.join(tmp.path, "d.txt")).text()).toBe(rest[0] === "one.txt" ? "two" : "one")
        // Alias spellings lock separately, so the exclusive reservation on the shared destination decides.
        await fs.mkdir(path.join(tmp.path, "real"))
        await fs.symlink(path.join(tmp.path, "real"), path.join(tmp.path, "alias"))
        await Bun.write(path.join(tmp.path, "three.txt"), "three")
        await Bun.write(path.join(tmp.path, "four.txt"), "four")
        const aliased = await Promise.all([
          move.execute({ source: "three.txt", destination: path.join("real", "e.txt") }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "four.txt", destination: path.join("alias", "e.txt") }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(aliased.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(aliased.find((outcome) => outcome !== "moved")).toContain("Destination already exists:")
        expect(await fs.readdir(path.join(tmp.path, "real"))).toEqual(["e.txt"])
        const kept = (await fs.readdir(tmp.path)).filter((name) => name === "three.txt" || name === "four.txt")
        expect(kept).toHaveLength(1)
      },
    })
  })

  test("throws when source and destination are the same path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Bun.write(path.join(tmp.path, "dir", "inner", "keep.txt"), "kept content")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await expect(
          move.execute({ source: "a.txt", destination: path.join(tmp.path, "a.txt") }, testCtx),
        ).rejects.toThrow("Source and destination are the same path:")
        // The project directory and the repository root are refused in either position, because an overwrite
        // would remove one of them recursively.
        await expect(move.execute({ source: ".", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "Source must not be the project directory or the repository root:",
        )
        await expect(move.execute({ source: tmp.path, destination: "b.txt" }, testCtx)).rejects.toThrow(
          "Source must not be the project directory or the repository root:",
        )
        await expect(move.execute({ source: "a.txt", destination: "." }, testCtx)).rejects.toThrow(
          "Destination must not be the project directory or the repository root:",
        )
        await expect(move.execute({ source: "dir", destination: path.join("dir", "inner") }, testCtx)).rejects.toThrow(
          "Source and destination overlap:",
        )
        await expect(move.execute({ source: path.join("dir", "inner"), destination: "dir" }, testCtx)).rejects.toThrow(
          "Source and destination overlap:",
        )
        // A link in a parent makes two different spellings the same entry, and it is that resolved identity,
        // not the spelling, that both the equality and the overlap refusals are decided on.
        await fs.symlink(path.join(tmp.path, "dir"), path.join(tmp.path, "alias"))
        await expect(
          move.execute({ source: path.join("dir", "inner"), destination: path.join("alias", "inner") }, testCtx),
        ).rejects.toThrow("Source and destination are the same path:")
        await expect(
          move.execute({ source: "dir", destination: path.join("alias", "inner") }, testCtx),
        ).rejects.toThrow("Source and destination overlap:")
        // Two hard links are two names for one entry rather than two entries, and renaming between them
        // succeeds as a no-op that would leave the source standing while this call reported a relocation. The
        // pair is refused on the identity of the entry itself, which is what tells them apart from two paths
        // that merely hold the same bytes.
        await fs.link(path.join(tmp.path, "a.txt"), path.join(tmp.path, "hard.txt"))
        await expect(
          move.execute({ source: "a.txt", destination: "hard.txt", overwrite: true }, testCtx),
        ).rejects.toThrow("Source and destination are the same path:")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "hard.txt")).text()).toBe("hello world")
        expect(requests).toEqual([])
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "dir", "inner", "keep.txt")).text()).toBe("kept content")
        expect((await fs.readdir(tmp.path)).sort()).toEqual([".git", "a.txt", "alias", "dir", "hard.txt"])
      },
    })
  })

  test("replaces the destination when overwrite is true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Bun.write(path.join(tmp.path, "b.txt"), "existing")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        // The stub context never reads a file, so a read before write assertion would reject this call.
        const result = await move.execute({ source: "a.txt", destination: "b.txt", overwrite: true }, ctx)
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).exists()).toBe(false)
        expect(result.output).toBe("Moved file a.txt to b.txt")
        expect(result.metadata.directory).toBe(false)
        expect(result.metadata.overwritten).toBe(true)
      },
    })
  })

  test("moves a directory with its nested contents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "dir", "nested", "file.txt"), "nested content")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        const result = await move.execute({ source: "dir", destination: "moved" }, ctx)
        expect(await Bun.file(path.join(tmp.path, "moved", "nested", "file.txt")).text()).toBe("nested content")
        // Read the parent listing rather than Bun.file(dir).exists(), which reports false for a real directory.
        expect(await fs.readdir(tmp.path)).not.toContain("dir")
        expect(result.title).toBe("dir -> moved")
        expect(result.output).toBe("Moved directory dir to moved")
        expect(result.metadata.directory).toBe(true)
        expect(result.metadata.overwritten).toBe(false)
        // A link is classified by the entry, never by its target, so a link to a directory travels as a
        // single link and the directory it names is left where it is.
        await fs.symlink("moved", path.join(tmp.path, "dirlink"))
        const link = await move.execute({ source: "dirlink", destination: "movedlink" }, ctx)
        expect(await fs.lstat(path.join(tmp.path, "movedlink")).then((stat) => stat.isSymbolicLink())).toBe(true)
        expect(await fs.readlink(path.join(tmp.path, "movedlink"))).toBe("moved")
        expect(await fs.readdir(tmp.path)).not.toContain("dirlink")
        expect(await fs.readdir(path.join(tmp.path, "moved"))).toEqual(["nested"])
        expect(link.output).toBe("Moved file dirlink to movedlink")
        expect(link.metadata.directory).toBe(false)
      },
    })
  })

  test("replaces a non-empty directory destination when overwrite is true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "dir", "keep.txt"), "kept content")
    await Bun.write(path.join(tmp.path, "target", "stale.txt"), "stale content")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        // A populated directory cannot be replaced directly, so it is staged aside and removed after commit.
        const result = await move.execute({ source: "dir", destination: "target", overwrite: true }, ctx)
        expect(await fs.readdir(path.join(tmp.path, "target"))).toEqual(["keep.txt"])
        expect(await Bun.file(path.join(tmp.path, "target", "keep.txt")).text()).toBe("kept content")
        expect(await fs.readdir(tmp.path)).not.toContain("dir")
        expect(result.output).toBe("Moved directory dir to target")
        expect(result.metadata.directory).toBe(true)
        expect(result.metadata.overwritten).toBe(true)
        // The old destination is moved aside rather than deleted so a failed relocation can put it back, and
        // nothing of that staging survives a relocation that succeeds.
        expect((await fs.readdir(tmp.path)).filter((name) => name.includes("opencode-move"))).toEqual([])
        // Two calls competing for one directory source: only one of them can relocate it, and the directory
        // the other one had already moved aside is put back, so the relocation that fails costs nothing.
        await Bun.write(path.join(tmp.path, "src", "moved.txt"), "moved content")
        await Bun.write(path.join(tmp.path, "left", "stale.txt"), "left stale")
        await Bun.write(path.join(tmp.path, "right", "stale.txt"), "right stale")
        const outcomes = await Promise.all([
          move.execute({ source: "src", destination: "left", overwrite: true }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "src", destination: "right", overwrite: true }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome !== "moved")).toContain("File or directory not found:")
        expect(await fs.readdir(tmp.path)).not.toContain("src")
        const left = await fs.readdir(path.join(tmp.path, "left"))
        const right = await fs.readdir(path.join(tmp.path, "right"))
        expect([left, right].filter((names) => names.includes("moved.txt"))).toHaveLength(1)
        expect([left, right].filter((names) => names.includes("stale.txt"))).toHaveLength(1)
        expect((await fs.readdir(tmp.path)).filter((name) => name.includes("opencode-move"))).toEqual([])
        // Directory moves reserve a free destination with an empty directory; the losing call removes it.
        await Bun.write(path.join(tmp.path, "tree", "leaf.txt"), "leaf content")
        const fresh = await Promise.all([
          move.execute({ source: "tree", destination: "first" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
          move.execute({ source: "tree", destination: "second" }, ctx).then(
            () => "moved",
            (err: Error) => err.message,
          ),
        ])
        expect(fresh.filter((outcome) => outcome === "moved")).toHaveLength(1)
        expect(fresh.find((outcome) => outcome !== "moved")).toContain("File or directory not found:")
        const landed = (await fs.readdir(tmp.path)).filter((name) => name === "first" || name === "second")
        expect(landed).toHaveLength(1)
        expect(await Bun.file(path.join(tmp.path, landed[0]!, "leaf.txt")).text()).toBe("leaf content")
        expect((await fs.readdir(tmp.path)).filter((name) => name.includes("opencode-move"))).toEqual([])
      },
    })
  })

  test("publishes file edited and watcher unlink and add events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Bus state is instance scoped, so both subscriptions belong inside the instance and before the call.
        const events: string[] = []
        const unsub = Bus.subscribe(File.Event.Edited, (event) => {
          events.push(`edited:${event.properties.file}`)
        })
        const unwatch = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
          events.push(`${event.properties.event}:${event.properties.file}`)
        })
        const move = await MoveTool.init()
        const result = await move.execute({ source: "a.txt", destination: "b.txt" }, ctx)
        // No wait is needed before unsubscribing: Bus.publish awaits its subscribers, so all three events have
        // already been delivered in order by the time execute resolves.
        unsub()
        unwatch()
        expect(events).toEqual([
          `edited:${path.join(tmp.path, "b.txt")}`,
          `unlink:${path.join(tmp.path, "a.txt")}`,
          `add:${path.join(tmp.path, "b.txt")}`,
        ])
        expect(result.metadata.source).toBe(path.join(tmp.path, "a.txt"))
        expect(result.metadata.destination).toBe(path.join(tmp.path, "b.txt"))
        expect(FileTime.get(ctx.sessionID, path.join(tmp.path, "b.txt"))).toBeInstanceOf(Date)
      },
    })
  })
})
