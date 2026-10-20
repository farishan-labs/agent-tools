import { sweep } from "../src/sweep.ts"
import { renderTable } from "../src/format.ts"

const rows = await sweep({ root: process.argv[2] ?? `${process.env.HOME}/dev/personal` })
console.log(
  renderTable({
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
  }),
)
