import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { candidateDocs, countLoc, findRepos, mineHint, sweep } from "../src/sweep.ts"

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "sweep-test-"))
}

describe("findRepos", () => {
  test("finds repos at the given depth", async () => {
    const root = await tempDir()
    try {
      await mkdir(join(root, "alpha", ".git"), { recursive: true })
      await mkdir(join(root, "nested", "beta", ".git"), { recursive: true })
      await mkdir(join(root, "not-a-repo"), { recursive: true })

      expect(await findRepos(root, 1)).toEqual([join(root, "alpha")])
      expect(await findRepos(root, 2)).toEqual([join(root, "alpha"), join(root, "nested", "beta")])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ignores directories that hold dependencies", async () => {
    const root = await tempDir()
    try {
      await mkdir(join(root, "node_modules", "pkg", ".git"), { recursive: true })
      expect(await findRepos(root, 3)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("countLoc", () => {
  test("counts source lines and skips build output", async () => {
    const root = await tempDir()
    try {
      await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n")
      await writeFile(join(root, "b.tsx"), "one\n")
      await mkdir(join(root, "dist"), { recursive: true })
      await writeFile(join(root, "dist", "c.ts"), "one\ntwo\n")

      expect(await countLoc(root)).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("candidateDocs", () => {
  test("finds the readme, the agents file and docs", async () => {
    const root = await tempDir()
    try {
      await writeFile(join(root, "README.md"), "# hi")
      await writeFile(join(root, "AGENTS.md"), "# hi")
      await mkdir(join(root, "docs"), { recursive: true })
      await writeFile(join(root, "docs", "plan.md"), "# plan")

      const docs = await candidateDocs(root)
      const names = docs.map((path) => path.slice(root.length + 1))
      expect(names).toContain("README.md")
      expect(names).toContain("AGENTS.md")
      expect(names).toContain("docs/plan.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("mineHint", () => {
  test("takes the last phase heading", async () => {
    const root = await tempDir()
    try {
      await writeFile(join(root, "README.md"), "# Phase 1\n\n# Phase 2\n\n# Phase 3?\n")
      expect(await mineHint([join(root, "README.md")])).toBe("Phase 3?")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("falls back to the first unchecked task", async () => {
    const root = await tempDir()
    try {
      await writeFile(join(root, "README.md"), "# Notes\n\n- [ ] write the parser\n- [ ] ship it\n")
      expect(await mineHint([join(root, "README.md")])).toBe("TODO: write the parser")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns a dash when the docs say nothing", async () => {
    const root = await tempDir()
    try {
      await writeFile(join(root, "README.md"), "# Notes\n\nJust prose.\n")
      expect(await mineHint([join(root, "README.md")])).toBe("-")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("sweep", () => {
  test("returns one row per repo, newest first", async () => {
    const root = await tempDir()
    try {
      await mkdir(join(root, "one", ".git"), { recursive: true })
      await mkdir(join(root, "two", ".git"), { recursive: true })

      const rows = await sweep({ root })
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.name).sort()).toEqual(["one", "two"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports a dash for a repo with no upstream", async () => {
    const root = await tempDir()
    try {
      await mkdir(join(root, "solo", ".git"), { recursive: true })
      const rows = await sweep({ root })
      expect(rows[0]!.unpushed).toBe("-")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
