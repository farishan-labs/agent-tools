/**
 * Sweep core: one call that surveys every git repo under a root.
 *
 * For each repo it reports the branch, how much uncommitted work is sitting
 * there, how many commits have not been pushed, when it was last touched, how
 * big it is, and -- the part that actually saves time -- a "next hint" mined
 * from the repo's own docs: the last phase/next/roadmap heading, or the first
 * unchecked task.
 *
 * Nothing here knows about OpenCode. The plugin is a thin wrapper over it, so
 * the same logic can back a CLI later.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { currentBranch, dirtyCount, lastCommitDate, unpushedCount } from "./git.ts"

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"])

/** Directories that hold dependencies or build output, never source worth counting. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  "target",
])

/** How deep under the repo root a docs/ file may live before we stop looking. */
const MAX_DOC_DEPTH = 4

const HINT_MAX = 46

/** Headings that name a piece of work still to do. */
const HEADING_RE = /^#{1,6}\s+.*(?:next|phase\s*\d|todo|roadmap|stage\s*\d|what'?s next)/i

/** An unchecked task in a markdown checklist. */
const TASK_RE = /^\s*[-*]\s+\[\s\]\s*(.*)$/

export interface SweepOptions {
  /** Directory to survey. */
  root: string
  /** How many directory levels below root to look for repos. 1 = direct children. */
  depth?: number
}

export interface RepoRow {
  name: string
  path: string
  branch: string
  dirty: number
  unpushed: number | string
  lastCommit: string
  loc: number
  nextHint: string
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"))
    return true
  } catch {
    return false
  }
}

/** Finds every git repo under `root`, up to `maxDepth` levels below it. */
export async function findRepos(root: string, maxDepth = 1): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, level: number): Promise<void> {
    if (level + 1 > maxDepth) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue

      const child = join(dir, entry.name)
      if (await hasGit(child)) {
        found.push(child)
        continue
      }
      await walk(child, level + 1)
    }
  }

  await walk(root, 0)
  return found.sort()
}

/** Counts source lines, ignoring dependencies and build output. */
export async function countLoc(dir: string): Promise<number> {
  let total = 0

  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!CODE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) continue

      try {
        const text = await readFile(path, "utf8")
        // Same count as `wc -l`: number of newlines.
        total += (text.match(/\n/g) ?? []).length
      } catch {
        // Unreadable file: skip it rather than fail the whole sweep.
      }
    }
  }

  await walk(dir)
  return total
}

/** Collects markdown files that look like project docs, in reading order. */
export async function candidateDocs(dir: string): Promise<string[]> {
  const docs: string[] = []

  for (const name of ["README.md", "AGENTS.md"]) {
    const path = join(dir, name)
    if (await isFile(path)) docs.push(path)
  }

  async function walk(current: string, level: number, insideDocs: boolean): Promise<void> {
    if (level > MAX_DOC_DEPTH) return

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    const here = insideDocs || basename(current) === "docs"

    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(".md")) continue
      if (here) docs.push(join(current, entry.name))
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
      await walk(join(current, entry.name), level + 1, here)
    }
  }

  await walk(dir, 0, false)
  return docs
}

function cleanHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim()
}

/** Mines a "what should happen next" hint out of the repo's docs. */
export async function mineHint(docs: string[]): Promise<string> {
  for (const file of docs) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    let last: string | undefined
    for (const line of text.split("\n")) {
      if (HEADING_RE.test(line)) last = cleanHeading(line)
    }
    if (last) return last
  }

  for (const file of docs) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      const match = TASK_RE.exec(line)
      if (match) return `TODO: ${match[1]!.trim()}`
    }
  }

  return "-"
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Surveys every repo under the root and returns one row per repo. */
export async function sweep(options: SweepOptions): Promise<RepoRow[]> {
  const depth = options.depth ?? 1
  const repos = await findRepos(options.root, depth)

  const rows: RepoRow[] = []
  for (const path of repos) {
    const docs = await candidateDocs(path)
    const hint = await mineHint(docs)
    rows.push({
      name: basename(path),
      path,
      branch: (await currentBranch(path)) ?? "-",
      dirty: await dirtyCount(path),
      unpushed: (await unpushedCount(path)) ?? "-",
      lastCommit: (await lastCommitDate(path)) ?? "-",
      loc: await countLoc(path),
      nextHint: truncate(hint, HINT_MAX),
    })
  }

  rows.sort((a, b) => b.lastCommit.localeCompare(a.lastCommit))
  return rows
}
