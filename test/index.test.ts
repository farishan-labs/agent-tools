import { describe, expect, test } from "bun:test"
import { computeDrift, parseIndex } from "../src/index.ts"

const SAMPLE = `# Personal projects

| Project | Location | Stack | Status |
|---|---|---|---|
| **action-planner** | docs/action-planner | Single HTML | Usage |
| **toyscripter** | games/toyscripter | Deno prototypes | Active |
`

describe("parseIndex", () => {
  test("reads name and location from each row", () => {
    const entries = parseIndex(SAMPLE)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: "action-planner", location: "docs/action-planner" })
    expect(entries[1]).toEqual({ name: "toyscripter", location: "games/toyscripter" })
  })

  test("skips the header and separator rows", () => {
    const entries = parseIndex(SAMPLE)
    expect(entries.some((entry) => entry.name === "Project")).toBe(false)
  })

  test("accepts a row without bold markers", () => {
    const entries = parseIndex("| plain | docs/plain | x | y |\n")
    expect(entries).toEqual([{ name: "plain", location: "docs/plain" }])
  })

  test("returns nothing for a document with no table", () => {
    expect(parseIndex("# Just a heading\n\nSome prose.\n")).toEqual([])
  })
})

describe("computeDrift", () => {
  const entries = parseIndex(SAMPLE)

  test("reports a repo the index does not mention", () => {
    const drift = computeDrift(entries, ["ahensi", "docs/action-planner"], ["docs/action-planner", "ahensi"])
    expect(drift.missingFromIndex).toEqual(["ahensi"])
  })

  test("an entry covers repos nested inside it", () => {
    const drift = computeDrift(entries, ["games/toyscripter/one", "games/toyscripter/two"], [])
    expect(drift.missingFromIndex).toEqual([])
  })

  test("reports an entry whose directory is gone", () => {
    const drift = computeDrift(entries, [], ["ahensi"])
    expect(drift.missingOnDisk).toEqual(["docs/action-planner", "games/toyscripter"])
  })

  test("an entry may point at a directory that is not a repo", () => {
    const drift = computeDrift(entries, [], ["docs/action-planner", "games/toyscripter"])
    expect(drift.missingOnDisk).toEqual([])
  })
})
