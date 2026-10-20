import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sweepPlugin from "../plugins/sweep.ts"
import doctorPlugin from "../plugins/doctor.ts"

/**
 * Drives a plugin the way OpenCode does -- call setup, capture the tool it
 * registers, then call that tool -- with a mock context. This checks the
 * wiring (permission asserted, input read, output shaped) without needing a
 * live model.
 */

interface RegisteredTool {
  name: string
  description: string
  input: unknown
  options?: { permission?: string; codemode?: boolean }
  execute: (input: unknown, context: unknown) => Promise<{ content?: string }>
}

async function register(plugin: unknown): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = []

  const ctx = {
    tool: {
      transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        callback({ add: (tool: RegisteredTool) => tools.push(tool) })
      },
    },
    permission: {
      assert: async (request: { action: string; resources: string[] }) => {
        ;(globalThis as Record<string, unknown>).__lastPermission = request
      },
    },
  }

  const setup = (plugin as { setup: (ctx: unknown) => Promise<unknown> }).setup
  await setup(ctx)
  return tools
}

function toolContext() {
  return {
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    progress: async () => {},
    signal: new AbortController().signal,
  }
}

describe("sweep plugin", () => {
  test("registers one tool with its own permission action", async () => {
    const tools = await register(sweepPlugin)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("sweep")
    expect(tools[0]!.options?.permission).toBe("sweep")
  })

  test("surveys a tree and returns a table", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweep-plugin-"))
    try {
      await mkdir(join(root, "alpha", ".git"), { recursive: true })
      await writeFile(join(root, "alpha", "README.md"), "# Alpha\n\n## Phase 2\n")

      const tools = await register(sweepPlugin)
      const result = await tools[0]!.execute({ root }, toolContext())

      expect(result.content).toContain("REPO")
      expect(result.content).toContain("alpha")
      expect(result.content).toContain("Phase 2")
      expect(result.content).toContain("1 repos")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("asserts the sweep permission before doing anything", async () => {
    const tools = await register(sweepPlugin)
    await tools[0]!.execute({ root: "/tmp" }, toolContext())

    const request = (globalThis as Record<string, unknown>).__lastPermission as { action: string; resources: string[] }
    expect(request.action).toBe("sweep")
    expect(request.resources).toEqual(["/tmp"])
  })

  test("says so when there is nothing to survey", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweep-empty-"))
    try {
      const tools = await register(sweepPlugin)
      const result = await tools[0]!.execute({ root }, toolContext())
      expect(result.content).toContain("No git repos found")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("doctor plugin", () => {
  test("registers one tool with its own permission action", async () => {
    const tools = await register(doctorPlugin)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("doctor")
    expect(tools[0]!.options?.permission).toBe("doctor")
  })

  test("returns a report even with the network switched off", async () => {
    const tools = await register(doctorPlugin)
    const result = await tools[0]!.execute({ offline: true, skipIndex: true }, toolContext())

    expect(result.content).toContain("gh")
    expect(result.content).toContain("checks")
  })

  test("asserts the doctor permission before doing anything", async () => {
    const tools = await register(doctorPlugin)
    await tools[0]!.execute({ offline: true, skipIndex: true }, toolContext())

    const request = (globalThis as Record<string, unknown>).__lastPermission as { action: string }
    expect(request.action).toBe("doctor")
  })
})
