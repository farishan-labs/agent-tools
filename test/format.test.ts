import { describe, expect, test } from "bun:test"
import { renderTable } from "../src/format.ts"

describe("renderTable", () => {
  test("aligns columns to their widest cell", () => {
    const output = renderTable({
      headers: ["REPO", "BRANCH"],
      rows: [
        ["ahensi", "main"],
        ["a-much-longer-name", "feature/thing"],
      ],
    })

    const lines = output.split("\n")
    // The header and every body row must start their second column at the
    // same offset. Line 1 is the rule, which contains no cell text.
    const branchColumn = lines[0]!.indexOf("BRANCH")
    expect(branchColumn).toBeGreaterThan(0)
    expect(lines[2]!.indexOf("main")).toBe(branchColumn)
    expect(lines[3]!.indexOf("feature/thing")).toBe(branchColumn)
  })

  test("prints the header even with no rows", () => {
    const output = renderTable({ headers: ["REPO"], rows: [] })
    expect(output.split("\n")).toHaveLength(2)
    expect(output).toContain("REPO")
  })

  test("renders a rule between the header and the body", () => {
    const output = renderTable({ headers: ["A"], rows: [["b"]] })
    expect(output.split("\n")[1]).toMatch(/^-+$/)
  })
})
