import { describe, expect, test } from "bun:test"
import { ingest } from "../src/ingest"
import { dailyTotals, grandTotal } from "../src/report"

const header = "id,customer,amount_cents,created_at"

describe("ingest", () => {
  test("accepts well formed rows", () => {
    const result = ingest([header, "ord_1,acme,1500,2026-02-28T10:00:00Z", "ord_2,bolt,250,2026-02-28T11:30:00Z"].join("\n"))
    expect(result.accepted.map((order) => order.id)).toEqual(["ord_1", "ord_2"])
    expect(result.skipped).toEqual([])
  })

  test("skips duplicates, bad amounts and malformed rows", () => {
    const result = ingest(["ord_1,acme,100,2026-02-28T10:00:00Z", "ord_1,acme,100,2026-02-28T10:00:00Z", "ord_2,bolt,12.5,2026-02-28T10:00:00Z", "ord_3,only,three"].join("\n"))
    expect(result.accepted).toHaveLength(1)
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["duplicate id", "invalid amount", "malformed row"])
  })

  test("skips rows whose timestamp is not a date", () => {
    const result = ingest("ord_1,acme,100,yesterday")
    expect(result.skipped).toEqual([{ id: "ord_1", reason: "invalid timestamp", raw: "yesterday" }])
  })
})

describe("dailyTotals", () => {
  test("adds up revenue per UTC day", () => {
    const { accepted } = ingest(["ord_1,acme,1000,2026-02-28T23:59:59Z", "ord_2,bolt,500,2026-03-01T00:00:00Z", "ord_3,acme,250,2026-03-01T08:00:00Z"].join("\n"))
    const totals = dailyTotals(accepted)
    expect(totals).toEqual({ "2026-02-28": 1000, "2026-03-01": 750 })
    expect(grandTotal(totals)).toBe(1750)
  })
})
