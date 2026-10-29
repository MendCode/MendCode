import { describe, expect, test } from "bun:test"
import { cartSummary } from "../src/cart"
import { paymentBody, paymentSubject } from "../src/email"
import { renderInvoice } from "../src/invoice"
import { renderReceipt } from "../src/receipt"
import { bestMonth, monthlyReport } from "../src/report"
import { fmtMoney } from "../src/util"

describe("documents", () => {
  test("invoice", () => {
    const text = renderInvoice([{ description: "Widget", quantity: 3, unitCents: 1999 }])
    expect(text).toContain("3 x $19.99 = $59.97")
    expect(text).toContain("Total: $59.97")
  })

  test("receipt shows change or what is still due", () => {
    expect(renderReceipt(1000, 1500)).toContain("Change: $5.00")
    expect(renderReceipt(1000, 400)).toContain("Still due: $6.00")
  })

  test("report", () => {
    const entries = [
      { month: "2026-01", revenueCents: 500000, costCents: 120000 },
      { month: "2026-02", revenueCents: 450000, costCents: 50000 },
    ]
    expect(monthlyReport(entries)[0]).toContain("net $3,800.00")
    expect(bestMonth(entries)).toBe("2026-02")
  })

  test("cart", () => {
    expect(cartSummary([{ name: "pen", priceCents: 250, quantity: 2 }])).toBe("2 items, $5.00")
  })

  test("email", () => {
    expect(paymentSubject(1234)).toBe("Payment received: $12.34")
    expect(paymentBody("Ana", 99)).toContain("$0.99")
    expect(fmtMoney(99)).toBe("$0.99")
  })
})
