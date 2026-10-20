/**
 * Thin git helpers.
 *
 * Everything shells out with an argument array, never a shell string, so a
 * path containing spaces or quotes cannot turn into an injection.
 */

import { run } from "./proc.ts"

const GIT_TIMEOUT = 10_000

/** A single-line git query, or undefined when the command fails. */
export async function gitLine(args: string[], cwd: string): Promise<string | undefined> {
  const result = await run("git", args, { cwd, timeout: GIT_TIMEOUT })
  return result.ok ? result.stdout : undefined
}

/** How many commits are on HEAD but not on the tracked upstream. */
export async function unpushedCount(cwd: string): Promise<number | undefined> {
  const result = await run("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd, timeout: GIT_TIMEOUT })
  if (!result.ok) return undefined
  const count = Number.parseInt(result.stdout, 10)
  return Number.isFinite(count) ? count : undefined
}

/** The date of the most recent commit, as YYYY-MM-DD. */
export async function lastCommitDate(cwd: string): Promise<string | undefined> {
  return gitLine(["log", "-1", "--format=%as"], cwd)
}

/** The current branch name, or undefined on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  return gitLine(["branch", "--show-current"], cwd)
}

/** How many tracked or untracked files differ from HEAD. */
export async function dirtyCount(cwd: string): Promise<number> {
  const result = await run("git", ["status", "--porcelain"], { cwd, timeout: GIT_TIMEOUT })
  if (!result.ok) return 0
  return result.stdout ? result.stdout.split("\n").filter(Boolean).length : 0
}
