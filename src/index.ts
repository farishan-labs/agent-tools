/**
 * Project index drift detection.
 *
 * A markdown index of projects is only useful if it matches what is actually
 * on disk. This module compares the two and reports the differences.
 *
 * The index is optional. On a machine without one, `checkIndex` returns a
 * skipped result rather than a failure -- a missing index is not a broken
 * machine.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { run } from "./proc.ts"

export interface IndexEntry {
  /** Project name as written in the index. */
  name: string
  /** Path relative to the root, as written in the index. */
  location: string
}

export interface IndexDrift {
  /** Directories on disk that the index does not mention. */
  missingFromIndex: string[]
  /** Index entries whose directory does not exist. */
  missingOnDisk: string[]
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".git", "vendor"])

/** Where the index lives by default. */
export function defaultIndexPath(): string {
  return join(homedir(), "dev", "personal", "docs", "PROJECTS.md")
}

/**
 * Parses a markdown table of projects.
 *
 * Rows look like `| **name** | location | stack | status |`. The name is
 * expected to be bold, but a plain name is accepted too -- the index is
 * hand-written and should not fail to parse over one missing asterisk.
 */
export function parseIndex(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = []

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 2) continue

    const name = cells[0]!.replace(/^\*\*|\*\*$/g, "").trim()
    const location = cells[1]!.replace(/^\*\*|\*\*$/g, "").trim()

    if (!name || !location) continue
    // Skip the separator row and any header row.
    if (/^-+$/.test(name) || /^-+$/.test(location)) continue
    if (/^project$/i.test(name) && /^location$/i.test(location)) continue

    entries.push({ name, location })
  }

  return entries
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Lists directories under `root`, up to `depth` levels, as relative paths. */
export async function listDirectories(root: string, depth = 2): Promise<string[]> {
  const found: string[] = []

  async function walk(current: string, prefix: string, level: number): Promise<void> {
    if (level > depth) return

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      found.push(relative)
      await walk(join(current, entry.name), relative, level + 1)
    }
  }

  await walk(root, "", 1)
  return found
}

/**
 * Lists git repos under `root`, as paths relative to root.
 *
 * Repos are what the index describes -- a project -- so this is the set that
 * drift should be measured against, not every directory.
 */
export async function listRepos(root: string, depth = 2): Promise<string[]> {
  const found: string[] = []

  async function walk(current: string, prefix: string, level: number): Promise<void> {
    if (level > depth) return

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (await isDir(join(current, entry.name, ".git"))) {
        found.push(relative)
        continue
      }
      await walk(join(current, entry.name), relative, level + 1)
    }
  }

  await walk(root, "", 1)
  return found
}

/**
 * Compares an index against the repos on disk.
 *
 * A repo counts as covered when the index points at it, or at a path inside
 * it -- an entry for `games/toyscripter` covers the seven repos nested under
 * it.
 *
 * `missingOnDisk` is checked against directories rather than repos, because
 * an index entry may legitimately point at a folder that is not a git repo.
 */
export function computeDrift(entries: IndexEntry[], repos: string[], directories: string[]): IndexDrift {
  const normalize = (value: string): string => value.replace(/^\.\//, "").replace(/\/$/, "")

  const covered = repos.filter((repo) =>
    entries.some((entry) => {
      const location = normalize(entry.location)
      return repo === location || repo.startsWith(`${location}/`) || location.startsWith(`${repo}/`)
    }),
  )

  const missingFromIndex = repos.filter((repo) => !covered.includes(repo))
  const missingOnDisk = entries
    .map((entry) => normalize(entry.location))
    .filter((location) => !directories.some((dir) => dir === location || location.startsWith(`${dir}/`)))

  return { missingFromIndex, missingOnDisk }
}

/** Compares a project index against what is on disk. */
export async function checkIndex(root: string, indexPath = defaultIndexPath()): Promise<IndexDrift | undefined> {
  let markdown: string
  try {
    markdown = await readFile(indexPath, "utf8")
  } catch {
    return undefined
  }

  const entries = parseIndex(markdown)
  const [repos, directories] = await Promise.all([listRepos(root), listDirectories(root)])
  return computeDrift(entries, repos, directories)
}

/**
 * Repos with commits that have never been pushed.
 * Used by the index check to flag work that is only on this machine.
 */
export async function reposWithUnpushed(root: string): Promise<string[]> {
  const repos = await listRepos(root, 1)
  const unpushed: string[] = []

  for (const repo of repos) {
    if (!(await isDir(join(root, repo, ".git")))) continue
    const result = await run("git", ["rev-list", "--count", "@{u}..HEAD"], {
      cwd: join(root, repo),
      timeout: 10_000,
    })
    if (!result.ok) continue
    const count = Number.parseInt(result.stdout, 10)
    if (Number.isFinite(count) && count > 0) unpushed.push(`${repo} (${count})`)
  }

  return unpushed
}
