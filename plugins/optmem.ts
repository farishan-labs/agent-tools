import { Plugin } from "@opencode/plugin"

/**
 * OptMem: an append-only memory that outlives every session, compaction, model
 * and vendor change. Run `wake` first in every session; `note` whenever you
 * learn something worth keeping.
 *
 * The CLI does the thinking. This tool only builds an argument array, runs the
 * binary directly (never through a shell), and returns its output verbatim --
 * `wake` pages itself, so truncating here would break the paging contract.
 */

const MEMO = `${process.env.HOME}/.local/bin/memory`
const ACTION = "optmem"
const TIMEOUT = 30_000

// `memo note` rejects anything longer, so catch it here with a better message
// than the CLI's. Keep in sync with OptMem's ENTRY_CHARS default.
const ENTRY_CHARS = 280

type Operation = "wake" | "note" | "recall" | "zoom" | "nap" | "forget"

interface Input {
  operation: Operation
  part?: number
  total?: number
  text?: string
  pattern?: string
  block?: string
  id?: string
}

/** A rejected call: reported back as content so the agent can correct it. */
class Rejected extends Error {}

function fail(message: string): never {
  throw new Rejected(message)
}

function requireNoExtras(input: Input, allowed: (keyof Input)[]) {
  for (const key of Object.keys(input)) {
    if (key === "operation") continue
    if ((input as unknown as Record<string, unknown>)[key] === undefined) continue
    if (!allowed.includes(key as keyof Input)) {
      fail(`\`${key}\` does not apply to \`${input.operation}\`. Allowed here: ${allowed.join(", ")}.`)
    }
  }
}

function count(name: string, value: unknown, min: number): number {
  if (value === undefined) fail(`\`${name}\` is required for this operation.`)
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`\`${name}\` must be a whole number >= ${min}, got ${JSON.stringify(value)}.`)
  }
  return value
}

/** One memory is one line: reject the shape the CLI would reject anyway. */
function memory(name: string, value: unknown): string {
  if (typeof value !== "string") fail(`\`${name}\` must be a string.`)
  const text = value.trim()
  if (!text) fail(`\`${name}\` is empty. A memory is one line of text.`)
  if (/[\n\r]/.test(text)) fail(`\`${name}\` spans several lines. Merge them, or note them separately.`)
  const bytes = new TextEncoder().encode(text).length
  if (bytes > ENTRY_CHARS) fail(`\`${name}\` is ${bytes} bytes, limit ${ENTRY_CHARS}. Compress it further.`)
  return text
}

function blockId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+-\d+$/.test(value)) {
    fail(`\`block\` must be a block id as wake prints it, like "16-31". Got ${JSON.stringify(value)}.`)
  }
  return value
}

/** Map the input onto the CLI's own argument shape. */
function toArgv(input: Input): string[] {
  switch (input.operation) {
    case "wake": {
      requireNoExtras(input, ["part", "total"])
      if (input.part === undefined && input.total !== undefined) {
        fail("`total` only makes sense together with `part`. Run `wake` and read the part count it prints.")
      }
      if (input.part === undefined) return ["wake"]
      const part = count("part", input.part, 1)
      if (input.total === undefined) return ["wake", String(part)]
      // T is the snapshot the part was rendered from, so a note landing mid-read
      // cannot shift a boundary and drop a line.
      return ["wake", String(part), String(count("total", input.total, 0))]
    }

    case "note": {
      requireNoExtras(input, ["text"])
      return ["note", memory("text", input.text)]
    }

    case "recall": {
      requireNoExtras(input, ["pattern"])
      if (typeof input.pattern !== "string" || !input.pattern.trim()) {
        fail("`pattern` must be a non-empty regex string.")
      }
      return ["recall", input.pattern]
    }

    case "zoom": {
      requireNoExtras(input, ["block"])
      return ["zoom", blockId(input.block)]
    }

    case "nap": {
      requireNoExtras(input, ["block", "text"])
      const hasBlock = input.block !== undefined
      const hasText = input.text !== undefined
      // No args lists the pending compression; block + text settles exactly one.
      if (hasBlock !== hasText) {
        fail("`nap` takes either nothing (list what is pending) or both `block` and `text` (settle one block).")
      }
      if (!hasBlock) return ["nap"]
      return ["nap", blockId(input.block), memory("text", input.text)]
    }

    case "forget": {
      requireNoExtras(input, ["id"])
      if (typeof input.id !== "string" || !input.id.trim()) {
        fail("`id` must be a non-empty memory id.")
      }
      return ["forget", input.id.trim()]
    }

    default:
      return fail(`Unknown operation ${JSON.stringify(input.operation)}.`)
  }
}

export default Plugin.define({
  id: "local-optmem",

  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ACTION,
        description:
          "Read and write OptMem, the permanent append-only memory for AI agents. " +
          "Run operation 'wake' first in every session and follow its paging footer until it says " +
          '"You are awake."; then \'note\' whenever you learn something worth keeping, and \'nap\' when a ' +
          "call asks for a compression. 'recall' searches every memory ever recorded and 'zoom' opens one " +
          "block of the tree into its two halves. Writes are appended only, one line of at most " +
          `${ENTRY_CHARS} bytes each. Permissions are governed by the "${ACTION}" action.`,

        input: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["wake", "note", "recall", "zoom", "nap", "forget"],
              description: "Which OptMem operation to run.",
            },
            part: {
              type: "number",
              description:
                "wake only: 1-based part index. Run `wake` first and read the part count it prints.",
            },
            total: {
              type: "number",
              description:
                "wake only: the T from the paging footer, the snapshot this part was rendered from.",
            },
            text: {
              type: "string",
              description: `note and nap: the one line to store, at most ${ENTRY_CHARS} bytes.`,
            },
            pattern: {
              type: "string",
              description: "recall only: a regex, matched case-insensitively against every memory.",
            },
            block: {
              type: "string",
              description: 'zoom and nap: a block id exactly as wake prints it, like "16-31".',
            },
            id: {
              type: "string",
              description: "forget only: memory id to tombstone.",
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },

        // Gives the tool its own permission action instead of borrowing one.
        options: { codemode: true, permission: ACTION },

        async execute(input, context) {
          const args = input as Input

          // The resource is the operation, so a rule can allow reads without
          // allowing writes. `save` is what "always" would persist: the request
          // action is stored separately, so these patterns match resources --
          // and are scoped to this one operation, never the whole action.
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: ACTION,
            resources: [args.operation],
            save: [args.operation],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })

          await context.progress({ status: `optmem ${args.operation}` })

          let argv: string[]
          try {
            argv = toArgv(args)
          } catch (error) {
            if (error instanceof Rejected) return { content: `${ACTION}: ${error.message}` }
            throw error
          }

          let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
          try {
            proc = Bun.spawn([MEMO, ...argv], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              // MEMORY_DIR selects the store; inherit whatever the session has.
              env: process.env,
              timeout: TIMEOUT,
              killSignal: "SIGKILL",
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              content: `${ACTION}: could not run ${MEMO} (${message}). Is OptMem installed and executable?`,
            }
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
            if (stderr.trim()) sections.push(stderr.trim())

            if (proc.signalCode !== null) {
              sections.push(`[killed: ${context.signal.aborted ? "cancelled" : `timed out after ${TIMEOUT}ms`}]`)
            } else if (code !== 0) {
              sections.push(`[exit ${code}]`)
            }

            return { content: sections.length ? sections.join("\n\n") : `[exit 0, no output]` }
          } finally {
            context.signal.removeEventListener("abort", onAbort)
          }
        },
      })
    })
  },
})