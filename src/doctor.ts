/**
 * Doctor core: check that this machine is wired up correctly.
 *
 * Every check here is portable -- it works on any laptop, with or without a
 * project index. Checks are grouped by what they inspect, run concurrently
 * where possible, and each returns a status rather than throwing, so one
 * broken integration never hides the others.
 *
 * Nothing here knows about OpenCode. The plugin is a thin wrapper over it.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { checkIndex, defaultIndexPath, reposWithUnpushed } from "./index.ts"
import { run } from "./proc.ts"

export type Status = "ok" | "warn" | "fail" | "skip"

export interface CheckResult {
  /** Group heading, e.g. "gh" or "ssh". */
  group: string
  /** What was checked, e.g. "github.com". */
  name: string
  status: Status
  detail: string
}

export interface DoctorOptions {
  /** Path to the opencode config to read MCP servers and env references from. */
  configPath?: string
  /** Hosts to test over SSH. Defaults to every Host in ~/.ssh/config. */
  sshHosts?: string[]
  /** Skip anything that touches the network. */
  offline?: boolean
  /** Root of the project tree to compare against the index. */
  projectRoot?: string
  /** Path to the project index. Defaults to ~/dev/personal/docs/PROJECTS.md. */
  indexPath?: string
  /** Skip the project index check entirely. */
  skipIndex?: boolean
}

const SSH_TIMEOUT = 8_000
const HTTP_TIMEOUT = 8_000

/** Where opencode keeps its global config on macOS and Linux. */
export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config")
  return join(base, "opencode", "opencode.json")
}

/** Every `Host` entry in ~/.ssh/config, minus wildcards and negations. */
export async function sshConfigHosts(): Promise<string[]> {
  const path = join(homedir(), ".ssh", "config")
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return []
  }

  const hosts: string[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*Host\s+(.+)$/i.exec(line)
    if (!match) continue
    for (const token of match[1]!.split(/\s+/)) {
      if (!token || token.startsWith("!") || token.includes("*") || token.includes("?")) continue
      hosts.push(token)
    }
  }
  return [...new Set(hosts)]
}

interface McpServer {
  type?: string
  url?: string
  command?: string
  headers?: Record<string, string>
}

interface OpencodeConfig {
  mcp?: { servers?: Record<string, McpServer> }
}

/** Reads the opencode config, tolerating a missing or malformed file. */
export async function readConfig(path: string): Promise<{ config: OpencodeConfig; raw: string }> {
  try {
    const raw = await readFile(path, "utf8")
    return { config: JSON.parse(raw) as OpencodeConfig, raw }
  } catch {
    return { config: {}, raw: "" }
  }
}

/**
 * Every env var the config refers to, as `{env:NAME}` placeholders.
 * Only the names are returned -- never the values.
 */
export function referencedEnvVars(raw: string): string[] {
  const names = new Set<string>()
  const pattern = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) names.add(match[1]!)
  return [...names]
}

function ok(group: string, name: string, detail: string): CheckResult {
  return { group, name, status: "ok", detail }
}

function warn(group: string, name: string, detail: string): CheckResult {
  return { group, name, status: "warn", detail }
}

function fail(group: string, name: string, detail: string): CheckResult {
  return { group, name, status: "fail", detail }
}

function skip(group: string, name: string, detail: string): CheckResult {
  return { group, name, status: "skip", detail }
}

async function checkGh(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const version = await run("gh", ["--version"], { timeout: 5_000 })

  if (!version.ok) {
    return [fail("gh", "cli", version.error ?? "gh is not installed or not on PATH")]
  }

  results.push(ok("gh", "cli", version.stdout.split("\n")[0] ?? "installed"))

  const auth = await run("gh", ["auth", "status"], { timeout: 8_000 })
  if (!auth.ok) {
    results.push(fail("gh", "auth", auth.stderr.split("\n")[0] ?? "not authenticated"))
    return results
  }

  // `gh auth status` lists one line per account: "✓  account  (keyring)".
  const accounts = auth.stdout
    .split("\n")
    .filter((line) => /Logged in to/.test(line))
    .map((line) => line.replace(/^[^a-zA-Z0-9]*/, "").replace(/^Logged in to /, "").trim())

  if (accounts.length === 0) {
    results.push(warn("gh", "auth", "no accounts listed"))
    return results
  }

  for (const account of accounts) results.push(ok("gh", account, "authenticated"))
  return results
}

async function checkSsh(hosts: string[], offline: boolean): Promise<CheckResult[]> {
  if (offline) return hosts.map((host) => skip("ssh", host, "offline -- skipped"))

  // Each host is independent, so probe them all at once instead of paying
  // the timeout once per host.
  return await Promise.all(
    hosts.map(async (host): Promise<CheckResult> => {
      const probe = await run(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=5",
          `git@${host}`,
        ],
        { timeout: SSH_TIMEOUT },
      )

      const combined = `${probe.stdout}\n${probe.stderr}`
      if (/successfully authenticated/i.test(combined)) {
        const who = /Hi [^!]+!/i.exec(combined)?.[0] ?? "authenticated"
        return ok("ssh", host, who)
      }
      if (/Permission denied/i.test(combined)) {
        return fail("ssh", host, "permission denied -- key not accepted")
      }
      if (probe.timedOut) return warn("ssh", host, "timed out")
      if (probe.error) return fail("ssh", host, probe.error)
      return warn("ssh", host, (probe.stderr || probe.stdout || "no response").split("\n")[0] ?? "unknown")
    }),
  )
}

async function checkMcp(servers: Record<string, McpServer>, offline: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "local" || server.command) {
      results.push(ok("mcp", name, `local: ${server.command ?? "spawned"}`))
      continue
    }

    if (!server.url) {
      results.push(warn("mcp", name, "no url or command configured"))
      continue
    }

    if (offline) {
      results.push(skip("mcp", name, server.url))
      continue
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT)
    try {
      const response = await fetch(server.url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json, text/event-stream" },
      })
      // Any HTTP answer proves the endpoint is reachable. 401 means reachable
      // but unauthenticated, which is a different problem from "not up".
      // MCP servers commonly answer 405 to a GET, since they expect a POST.
      if (response.status === 401 || response.status === 403) {
        results.push(warn("mcp", name, `reachable, auth required (${response.status})`))
      } else {
        results.push(ok("mcp", name, `reachable (${response.status})`))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("abort")) {
        results.push(warn("mcp", name, "timed out"))
      } else {
        results.push(fail("mcp", name, message))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return results
}

function checkEnv(names: string[]): CheckResult[] {
  return names.map((name) =>
    process.env[name] && process.env[name]!.length > 0
      ? ok("env", name, "set")
      : fail("env", name, "not set"),
  )
}

/** Verifies that every plugin file in the plugins dir loads and resolves. */
async function checkPlugins(dir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return [skip("plugins", dir, "plugins directory not found")]
  }

  // A symlinked plugin reports as neither a file nor a directory, so both
  // kinds are taken. Symlinks are the normal case: the install script links
  // plugins in from a checkout.
  const files = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".ts"))
  if (files.length === 0) return [skip("plugins", dir, "no plugins installed")]

  for (const entry of files) {
    const path = join(dir, entry.name)

    let broken = false
    try {
      const info = await stat(path)
      broken = info.size === 0
    } catch {
      // A symlink whose target is gone: the usual way a plugin breaks.
      broken = true
    }

    if (broken) {
      results.push(fail("plugins", entry.name, "empty, unreadable, or a broken symlink"))
      continue
    }

    try {
      const real = await readFile(path, "utf8")
      results.push(ok("plugins", entry.name, `${real.split("\n").length} lines`))
    } catch {
      results.push(fail("plugins", entry.name, "cannot read -- broken symlink?"))
    }
  }

  return results
}

/**
 * Compares the project index against what is on disk.
 *
 * The index is optional: on a machine without one this skips rather than
 * fails, because a missing index is not a broken machine.
 */
async function checkProjectIndex(root: string, indexPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  const drift = await checkIndex(root, indexPath)
  if (!drift) {
    return [skip("index", indexPath, "no index found -- skipping drift check")]
  }

  if (drift.missingFromIndex.length === 0) {
    results.push(ok("index", "coverage", "every directory on disk is in the index"))
  } else {
    results.push(
      warn(
        "index",
        "coverage",
        `${drift.missingFromIndex.length} not in the index: ${drift.missingFromIndex.join(", ")}`,
      ),
    )
  }

  if (drift.missingOnDisk.length === 0) {
    results.push(ok("index", "entries", "every index entry exists on disk"))
  } else {
    results.push(
      warn("index", "entries", `${drift.missingOnDisk.length} missing on disk: ${drift.missingOnDisk.join(", ")}`),
    )
  }

  const unpushed = await reposWithUnpushed(root)
  if (unpushed.length === 0) {
    results.push(ok("index", "unpushed", "no repo has unpushed commits"))
  } else {
    results.push(warn("index", "unpushed", unpushed.join(", ")))
  }

  return results
}

/** Runs every check and returns the results, grouped in a stable order. */
export async function doctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const configPath = options.configPath ?? defaultConfigPath()
  const { config, raw } = await readConfig(configPath)

  const hosts = options.sshHosts ?? (await sshConfigHosts())
  const pluginsDir = join(homedir(), ".config", "opencode", "plugins")
  const projectRoot = options.projectRoot ?? join(homedir(), "dev", "personal")
  const indexPath = options.indexPath ?? defaultIndexPath()

  const [ghResults, sshResults, mcpResults] = await Promise.all([
    checkGh(),
    checkSsh(hosts, options.offline ?? false),
    checkMcp(config.mcp?.servers ?? {}, options.offline ?? false),
  ])

  const results: CheckResult[] = [
    ...ghResults,
    ...sshResults,
    ...mcpResults,
    ...checkEnv(referencedEnvVars(raw)),
    ...(await checkPlugins(pluginsDir)),
  ]

  if (!options.skipIndex) {
    results.push(...(await checkProjectIndex(projectRoot, indexPath)))
  }

  return results
}
