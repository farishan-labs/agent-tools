import { Plugin } from "@opencode/plugin"

const DEFAULT_TIMEOUT = 120_000
const MAX_CHARS = 30_000
const HEAD_CHARS = 20_000
const TAIL_CHARS = 5_000

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text
  const dropped = text.length - HEAD_CHARS - TAIL_CHARS
  return `${text.slice(0, HEAD_CHARS)}\n\n... [${dropped} chars truncated] ...\n\n${text.slice(-TAIL_CHARS)}`
}

export default Plugin.define({
  id: "local-sh",

  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sh",
        description:
          "Run a shell command on this machine and return its stdout, stderr, and exit code. " +
          'Uses the user\'s shell, so normal tools, pipes, and quoting all work: "git status", ' +
          '"rg --files | head -20", "bun test". Pass workdir to change directory and timeout in ' +
          "milliseconds to bound the run. Requires permission before executing.",

        input: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Shell command to execute.",
            },
            workdir: {
              type: "string",
              description: "Working directory. Defaults to the session directory.",
            },
            timeout: {
              type: "number",
              description: `Kill the command after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT}.`,
            },
          },
          required: ["command"],
          additionalProperties: false,
        },

        options: { codemode: true },

        async execute(input, context) {
          const { command, workdir, timeout } = input as {
            command: string
            workdir?: string
            timeout?: number
          }

          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "shell",
            resources: [command],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })

          await context.progress({ status: command })

          const shell = process.env.SHELL ?? "/bin/sh"
          const limit = timeout ?? DEFAULT_TIMEOUT

          let proc
          try {
            proc = Bun.spawn([shell, "-c", command], {
              cwd: workdir,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: process.env,
              timeout: limit,
              killSignal: "SIGKILL",
            })
          } catch (error) {
            return { content: `Failed to start command: ${error instanceof Error ? error.message : String(error)}` }
          }

          const onAbort = () => proc.kill()
          context.signal.addEventListener("abort", onAbort, { once: true })

          try {
            const [stdout, stderr, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])

            const sections: string[] = []
            if (stdout.trim()) sections.push(stdout.trim())
            if (stderr.trim()) sections.push(`[stderr]\n${stderr.trim()}`)

            const killed = proc.signalCode !== null
            if (killed) {
              const reason = context.signal.aborted ? "cancelled" : `timed out after ${limit}ms`
              sections.push(`[killed: ${reason}]`)
            } else if (code !== 0) {
              sections.push(`[exit ${code}]`)
            } else if (sections.length === 0) {
              sections.push(`[exit 0, no output]`)
            }

            return { content: truncate(sections.join("\n\n")) }
          } finally {
            context.signal.removeEventListener("abort", onAbort)
          }
        },
      })
    })
  },
})
