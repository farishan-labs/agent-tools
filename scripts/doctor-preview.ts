import { doctor } from "../src/doctor.ts"

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" }
const results = await doctor({
  offline: process.argv.includes("--offline"),
  skipIndex: process.argv.includes("--no-index"),
})

let group = ""
for (const result of results) {
  if (result.group !== group) {
    group = result.group
    console.log(`\n${group}`)
  }
  console.log(`  ${MARK[result.status]}  ${result.name.padEnd(24)} ${result.detail}`)
}

const failures = results.filter((r) => r.status === "fail").length
const warnings = results.filter((r) => r.status === "warn").length
console.log(`\n${results.length} checks · ${failures} failing · ${warnings} warning`)
