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
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        await expect(move.execute({ source: "missing.txt", destination: "b.txt" }, ctx)).rejects.toThrow(
          "File or directory not found:",
        )
        expect(await Bun.file(path.join(tmp.path, "b.txt")).exists()).toBe(false)
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
        await expect(move.execute({ source: "a.txt", destination: "b.txt" }, ctx)).rejects.toThrow(
          "Destination already exists:",
        )
        // Neither endpoint changed, which is what proves the guard runs ahead of every mutation.
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
        expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("existing")
      },
    })
  })

  test("throws when source and destination are the same path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "hello world")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const move = await MoveTool.init()
        // One relative and one absolute spelling of the same entry, so resolution decides the equality.
        await expect(move.execute({ source: "a.txt", destination: path.join(tmp.path, "a.txt") }, ctx)).rejects.toThrow(
          "Source and destination are the same path:",
        )
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("hello world")
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
        const result = await move.execute({ source: "a.txt", destination: "b.txt" }, ctx)
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()
        unwatch()
        expect(events).toEqual([
          `edited:${result.metadata.destination}`,
          `unlink:${result.metadata.source}`,
          `add:${result.metadata.destination}`,
        ])
      },
    })
  })
})
