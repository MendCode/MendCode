import { expect, test } from "bun:test"
import { FEATURE_IDS, FEATURES } from "../packages/protocol/src/tier-data"
import { END, START, renderTierTable, tiersMatch } from "./readme-tiers"

test("README contains the exact current manifest table and every linked guide exists", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
  expect(tiersMatch(readme)).toBe(true)
  for (const id of FEATURE_IDS) {
    expect(renderTierTable().split(`(\`${id}\`)`)).toHaveLength(2)
    expect(await Bun.file(new URL(`../${FEATURES[id].doc}`, import.meta.url)).exists()).toBe(true)
  }
})

test("kernel, included and opt-in features have distinct tier states", () => {
  const table = renderTierTable()
  expect(table).toContain("(`extensions`) | Kernel | Kernel | Kernel |")
  expect(table).toContain("(`codegraph`) | — | Included | Included |")
  expect(table).toContain("(`pi`) | — | — | Opt-in |")
  expect(table).toContain("/handoff &lt;goal&gt;")
})

test("manifest changes, edited rows and malformed boundaries fail the drift check", () => {
  const table = renderTierTable()
  const changed = renderTierTable({ ...FEATURES, codegraph: { ...FEATURES.codegraph, tier: "full" } })
  expect(tiersMatch(table, changed)).toBe(false)
  expect(tiersMatch(table.replace("Code graph tools", "Graph"))).toBe(false)
  expect(tiersMatch(table.replace(END, ""))).toBe(false)
  expect(tiersMatch(`${START}\n${table}`)).toBe(false)
  expect(tiersMatch(`${table}\n${END}`)).toBe(false)
})
