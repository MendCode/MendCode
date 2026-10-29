import { describe, expect, test } from "bun:test"
import { ingest } from "../src/ingest"
import { dailyTotals, grandTotal } from "../src/report"
import { parseTimestamp } from "../src/timestamp"

const header = "id,customer,amount_cents,created_at"

describe("parseTimestamp", () => {
  test("keeps accepting plain UTC", () => {
    expect(parseTimestamp("2026-03-01T08:15:00Z")?.toISOString()).toBe("2026-03-01T08:15:00.000Z")
  })
  test("accepts fractional seconds", () => {
    expect(parseTimestamp("2026-03-01T14:45:30.250Z")?.toISOString()).toBe("2026-03-01T14:45:30.250Z")
  })
  test("accepts numeric offsets and converts them to the same instant", () => {
    expect(parseTimestamp("2026-03-01T23:30:00+01:00")?.toISOString()).toBe("2026-03-01T22:30:00.000Z")
    expect(parseTimestamp("2026-03-01T09:00:00-05:00")?.toISOString()).toBe("2026-03-01T14:00:00.000Z")
    expect(parseTimestamp("2026-03-02T05:45:00+05:30")?.toISOString()).toBe("2026-03-02T00:15:00.000Z")
  })
  test("still rejects text that is not a timestamp", () => {
    expect(parseTimestamp("yesterday")).toBeUndefined()
    expect(parseTimestamp("")).toBeUndefined()
    expect(parseTimestamp("2026-03-01")).toBeUndefined()
    expect(parseTimestamp("2026-03-01 10:00:00")).toBeUndefined()
    expect(parseTimestamp("2026-13-01T10:00:00Z")).toBeUndefined()
  })
})

describe("ingest", () => {
  test("accepts rows from every supplier format", () => {
    const csv = [
      header,
      "ord_1001,acme,15000,2026-03-01T08:15:00Z",
      "ord_1002,northwind,8200,2026-03-01T23:30:00+01:00",
      "ord_1005,acme,990,2026-03-01T14:45:30.250Z",
      "ord_1006,fabrikam,23000,2026-03-01T09:00:00-05:00",
    ].join("\n")
    const result = ingest(csv)
    expect(result.skipped).toEqual([])
    expect(result.accepted.map((order) => order.id)).toEqual(["ord_1001", "ord_1002", "ord_1005", "ord_1006"])
  })

  test("other skip reasons are untouched", () => {
    const csv = ["ord_1,acme,100,2026-03-01T10:00:00Z", "ord_1,acme,100,2026-03-01T10:00:00+01:00", "ord_2,bolt,1.5,2026-03-01T10:00:00Z", "ord_3,x", "ord_4,acme,100,nope"].join("\n")
    const result = ingest(csv)
    expect(result.accepted.map((order) => order.id)).toEqual(["ord_1"])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["duplicate id", "invalid amount", "malformed row", "invalid timestamp"])
  })
})

describe("dailyTotals", () => {
  test("buckets by the UTC day of the instant, not by the written date", () => {
    const csv = [
      "ord_1,a,1000,2026-03-01T23:30:00+01:00", // 22:30Z on the 1st
      "ord_2,a,500,2026-03-02T00:30:00+01:00", // 23:30Z on the 1st
      "ord_3,a,250,2026-03-02T01:30:00+01:00", // 00:30Z on the 2nd
      "ord_4,a,100,2026-03-01T20:00:00-05:00", // 01:00Z on the 2nd
    ].join("\n")
    const totals = dailyTotals(ingest(csv).accepted)
    expect(totals).toEqual({ "2026-03-01": 1500, "2026-03-02": 350 })
  })

  test("the sample feed adds up to what finance expects", async () => {
    const csv = await Bun.file(new URL("../data/orders-2026-03-02.csv", import.meta.url)).text()
    const result = ingest(csv)
    expect(result.skipped).toEqual([])
    expect(grandTotal(dailyTotals(result.accepted))).toBe(120580)
  })
})
