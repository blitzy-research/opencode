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
        // Both endpoints are inside the project, so the boundary guard stays silent.
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
        // An empty path, or one shaped like a glob, is refused by the schema before execute runs at all.
        await expect(move.execute({ source: "", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        await expect(move.execute({ source: "a.txt", destination: "" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        await expect(move.execute({ source: "*.txt", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        await expect(move.execute({ source: "a.txt", destination: "b?.txt" }, testCtx)).rejects.toThrow(
          "The move tool was called with invalid arguments",
        )
        // None of those four asked for consent, so a wildcard never reaches a permission pattern.
        expect(requests).toEqual([])
        // A source that disappears while the permission request is pending is caught again under the lock.
        await expect(
          move.execute(
            { source: "a.txt", destination: "c.txt" },
            {
              ...ctx,
              ask: async () => {
                await fs.rm(path.join(tmp.path, "a.txt"))
              },
            },
          ),
        ).rejects.toThrow("File or directory not found:")
        expect(await fs.readdir(tmp.path)).toEqual([".git"])
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
        // Neither endpoint changed, which is what proves the guard runs ahead of every mutation.
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("existing")
        // A dangling link is an entry of its own, so it is protected without being followed.
        await fs.symlink("ghost.txt", path.join(tmp.path, "link.txt"))
        await expect(move.execute({ source: "a.txt", destination: "link.txt" }, testCtx)).rejects.toThrow(
          "Destination already exists:",
        )
        expect(await fs.readlink(path.join(tmp.path, "link.txt"))).toBe("ghost.txt")
        // Consent was never requested for either refusal, so validation completes before the edit request.
        expect(requests).toEqual([])
        // A destination that appears while the permission request is pending is caught again under the lock.
        await expect(
          move.execute(
            { source: "a.txt", destination: "c.txt" },
            {
              ...ctx,
              ask: async () => {
                await Bun.write(path.join(tmp.path, "c.txt"), "arrived late")
              },
            },
          ),
        ).rejects.toThrow("Destination already exists:")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "c.txt")).text()).toBe("arrived late")
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
        // Exactly one source survives, and the destination holds the content of the one that moved.
        const rest = (await fs.readdir(tmp.path)).filter((name) => name === "one.txt" || name === "two.txt")
        expect(rest).toHaveLength(1)
        expect(await Bun.file(path.join(tmp.path, "d.txt")).text()).toBe(rest[0] === "one.txt" ? "two" : "one")
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
        // One relative and one absolute spelling of the same entry, so resolution decides the equality.
        await expect(
          move.execute({ source: "a.txt", destination: path.join(tmp.path, "a.txt") }, testCtx),
        ).rejects.toThrow("Source and destination are the same path:")
        // The project root is refused in either position, because an overwrite would remove it recursively.
        await expect(move.execute({ source: ".", destination: "b.txt" }, testCtx)).rejects.toThrow(
          "Source must not be the project root:",
        )
        await expect(move.execute({ source: tmp.path, destination: "b.txt" }, testCtx)).rejects.toThrow(
          "Source must not be the project root:",
        )
        await expect(move.execute({ source: "a.txt", destination: "." }, testCtx)).rejects.toThrow(
          "Destination must not be the project root:",
        )
        // Neither endpoint may contain the other, in either direction.
        await expect(move.execute({ source: "dir", destination: path.join("dir", "inner") }, testCtx)).rejects.toThrow(
          "Source and destination overlap:",
        )
        await expect(move.execute({ source: path.join("dir", "inner"), destination: "dir" }, testCtx)).rejects.toThrow(
          "Source and destination overlap:",
        )
        // Every refusal came before consent, and the project is exactly as it was seeded.
        expect(requests).toEqual([])
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "dir", "inner", "keep.txt")).text()).toBe("kept content")
        expect((await fs.readdir(tmp.path)).sort()).toEqual([".git", "a.txt", "dir"])
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
        // Renaming onto a populated directory fails with ENOTEMPTY, so the recursive removal has to run first.
        const result = await move.execute({ source: "dir", destination: "target", overwrite: true }, ctx)
        expect(await fs.readdir(path.join(tmp.path, "target"))).toEqual(["keep.txt"])
        expect(await Bun.file(path.join(tmp.path, "target", "keep.txt")).text()).toBe("kept content")
        expect(await fs.readdir(tmp.path)).not.toContain("dir")
        expect(result.output).toBe("Moved directory dir to target")
        expect(result.metadata.directory).toBe(true)
        expect(result.metadata.overwritten).toBe(true)
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
        // Every publication is awaited and Bus.publish awaits its subscribers, so the three events have
        // already arrived by the time execute resolves and no wait is needed here.
        const result = await move.execute({ source: "a.txt", destination: "b.txt" }, ctx)
        unsub()
        unwatch()
        // The expectations come from the fixture rather than from the result, so the payloads are proven
        // independently of the metadata the same call returned.
        expect(events).toEqual([
          `edited:${path.join(tmp.path, "b.txt")}`,
          `unlink:${path.join(tmp.path, "a.txt")}`,
          `add:${path.join(tmp.path, "b.txt")}`,
        ])
        expect(result.metadata.source).toBe(path.join(tmp.path, "a.txt"))
        expect(result.metadata.destination).toBe(path.join(tmp.path, "b.txt"))
      },
    })
  })
})
