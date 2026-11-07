import { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { renderTable } from "sweep/format"
import { sweep } from "sweep"

/**
 * Sweep: one call that surveys every git repo under a root.
 *
 * The point of the tool is that a single call replaces a dozen `git status`
 * round-trips, and the "next hint" column tells you what each repo says it
 * should be working on -- mined from the repo's own docs, not guessed.
 */

const ACTION = "sweep"

/** Where repos live when the caller does not say. */
function defaultRoot(): string {
  const home = homedir()
  const personal = join(home, "dev", "personal")
  return existsSync(personal) ? personal : process.cwd()
}

export default Plugin.define({
  id: "agent-tools-sweep",

  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ACTION,
        description:
          "Survey every git repo under a root directory and return one row per repo: " +
          "branch, uncommitted file count, unpushed commits, last commit date, source line count, " +
          "and a 'next hint' mined from the repo's own docs (the last phase/next/roadmap heading, " +
          "or the first unchecked task). Use this to see the whole landscape of several projects " +
          "at once instead of running git status in each one. Read-only: it never writes to a repo.",

        input: {
          type: "object",
          properties: {
            root: {
              type: "string",
              description:
                "Directory to survey. Defaults to ~/dev/personal when it exists, otherwise the current directory.",
            },
            depth: {
              type: "number",
              description: "How many directory levels below root to look for repos. 1 = direct children only.",
            },
          },
          additionalProperties: false,
        },

        // Native, not codemode: the tool is called directly, so a sweep costs
        // one round trip instead of a script that wraps another call.
        // It still gets its own permission action instead of borrowing one.
        options: { permission: ACTION },

        async execute(input, context) {
          const args = input as { root?: string; depth?: number }
          const root = args.root ?? defaultRoot()

          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: ACTION,
            resources: [root],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })

          await context.progress({ status: `sweep ${root}` })

          const rows = await sweep({ root, depth: args.depth })

          if (rows.length === 0) {
            return { content: `No git repos found under ${root}.` }
          }

          const table = renderTable({
            headers: ["REPO", "BRANCH", "DIR", "UNPUSH", "LAST_COMMIT", "LOC", "NEXT_HINT"],
            rows: rows.map((row) => [
              row.name,
              row.branch,
              String(row.dirty),
              String(row.unpushed),
              row.lastCommit,
              String(row.loc),
              row.nextHint,
            ]),
          })

          const total = rows.reduce((sum, row) => sum + (typeof row.unpushed === "number" ? row.unpushed : 0), 0)
          const dirty = rows.reduce((sum, row) => sum + row.dirty, 0)
          const footer = [
            `${rows.length} repos`,
            dirty > 0 ? `${dirty} uncommitted` : "clean",
            total > 0 ? `${total} unpushed` : "nothing unpushed",
          ].join(" · ")

          return { content: `${table}\n\n${footer}` }
        },
      })
    })
  },
})
