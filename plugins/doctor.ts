import { Plugin } from "@opencode/plugin"
import { doctor, type CheckResult } from "sweep/doctor"

/**
 * Doctor: check that this machine is wired up correctly.
 *
 * Every check is portable -- it works on any laptop, with or without a
 * project index -- and each one reports independently, so a single broken
 * integration never hides the rest.
 */

const ACTION = "doctor"

const MARK: Record<CheckResult["status"], string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  skip: "skip",
}

function render(results: CheckResult[]): string {
  const lines: string[] = []
  let group = ""

  for (const result of results) {
    if (result.group !== group) {
      group = result.group
      lines.push(`\n${group}`)
    }
    lines.push(`  ${MARK[result.status]}  ${result.name.padEnd(22)} ${result.detail}`)
  }

  const failures = results.filter((result) => result.status === "fail").length
  const warnings = results.filter((result) => result.status === "warn").length
  const skipped = results.filter((result) => result.status === "skip").length

  const summary = [
    `${results.length} checks`,
    failures > 0 ? `${failures} failing` : "none failing",
    warnings > 0 ? `${warnings} warning` : "no warnings",
    skipped > 0 ? `${skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return `${lines.join("\n")}\n\n${summary}`
}

export default Plugin.define({
  id: "agent-tools-doctor",

  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ACTION,
        description:
          "Check that this machine is wired up correctly. Verifies gh authentication for every " +
          "account, SSH access to every host in ~/.ssh/config, that each MCP server in the opencode " +
          "config is reachable, that every environment variable the config references is set, and " +
          "that the installed plugins are readable. Use it when a tool is failing for an unclear " +
          "reason, or before starting work on a new machine. Read-only: it only inspects.",

        input: {
          type: "object",
          properties: {
            offline: {
              type: "boolean",
              description: "Skip the checks that reach the network (SSH and MCP).",
            },
            skipIndex: {
              type: "boolean",
              description:
                "Skip the project index check. Useful on a machine without a project index, or to keep the check fast.",
            },
            configPath: {
              type: "string",
              description: "Path to the opencode config to read MCP servers and env references from.",
            },
          },
          additionalProperties: false,
        },

        // Native, not codemode: the tool is called directly, so a doctor run
        // costs one round trip instead of a script that wraps another call.
        // It still gets its own permission action instead of borrowing one.
        options: { permission: ACTION },

        async execute(input, context) {
          const args = input as { offline?: boolean; skipIndex?: boolean; configPath?: string }

          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: ACTION,
            resources: ["doctor"],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })

          await context.progress({ status: "doctor" })

          const results = await doctor({
            offline: args.offline,
            skipIndex: args.skipIndex,
            configPath: args.configPath,
          })

          return { content: render(results) }
        },
      })
    })
  },
})
