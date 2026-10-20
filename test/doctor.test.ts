import { describe, expect, test } from "bun:test"
import { referencedEnvVars, sshConfigHosts } from "../src/doctor.ts"

describe("referencedEnvVars", () => {
  test("finds every {env:NAME} placeholder", () => {
    const raw = '{"headers":{"Authorization":"Bearer {env:HUBTON_CATALOG_TOKEN}"}}'
    expect(referencedEnvVars(raw)).toEqual(["HUBTON_CATALOG_TOKEN"])
  })

  test("finds several distinct names", () => {
    const raw = "{env:ONE} and {env:TWO} and {env:ONE}"
    expect(referencedEnvVars(raw).sort()).toEqual(["ONE", "TWO"])
  })

  test("returns nothing when there are no placeholders", () => {
    expect(referencedEnvVars('{"key":"value"}')).toEqual([])
  })
})

describe("sshConfigHosts", () => {
  test("returns an empty list when there is no ssh config", async () => {
    // The result depends on the machine, but it must never throw.
    const hosts = await sshConfigHosts()
    expect(Array.isArray(hosts)).toBe(true)
  })
})
