import { fmtMoney } from "./util"

export function paymentSubject(amountCents: number, currency = "USD"): string {
  return `Payment received: ${fmtMoney(amountCents, currency)}`
}

export function paymentBody(name: string, amountCents: number, currency = "USD"): string {
  return `Hi ${name}, we received your payment of ${fmtMoney(amountCents, currency)}. Thank you!`
}
