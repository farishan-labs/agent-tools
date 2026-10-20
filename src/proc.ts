/**
 * A single place where external commands are launched.
 *
 * Commands are always given as an argument array, never a shell string, so a
 * path containing spaces, quotes or a semicolon cannot turn into an injection.
 * Nothing here throws: a failed command is a result, not an exception.
 */

export interface RunOptions {
  cwd?: string
  timeout?: number
  env?: Record<string, string | undefined>
}

export interface RunResult {
  /** The command's exit code, or -1 when it never started. */
  code: number
  stdout: string
  stderr: string
  /** True when the command exited 0. */
  ok: boolean
  /** True when the command was killed by the timeout. */
  timedOut: boolean
  /** Set when the command could not be started at all. */
  error?: string
}

const DEFAULT_TIMEOUT = 15_000

/** A subprocess with both output streams piped, so both can be read. */
type Piped = Bun.Subprocess<"ignore", "pipe", "pipe">

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT

  let proc: Piped
  try {
    proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: options.env ?? process.env,
      timeout,
      killSignal: "SIGKILL",
    })
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: "",
      ok: false,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    const timedOut = proc.signalCode !== null
    return {
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      ok: code === 0 && !timedOut,
      timedOut,
    }
  } finally {
    proc.kill()
  }
}

/** True when the command exists and answers `--version` without error. */
export async function commandExists(command: string): Promise<boolean> {
  const result = await run(command, ["--version"], { timeout: 5_000 })
  return result.ok
}

/** The first line of a command's `--version` output, e.g. "gh 2.62.0". */
export async function commandVersion(command: string): Promise<string | undefined> {
  const result = await run(command, ["--version"], { timeout: 5_000 })
  const line = result.stdout.split("\n")[0]?.trim()
  return line || undefined
}
