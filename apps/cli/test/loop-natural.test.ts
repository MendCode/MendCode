import { describe, expect, test } from "bun:test"
import { parseLoopCommand, readSchedule } from "../src/view/loop-command"

const schedule = (text: string) => {
  const read = readSchedule(text)
  if (!("trigger" in read)) throw new Error(JSON.stringify(read))
  return read
}

describe("/loop in natural language: the local parser (no tokens)", () => {
  test("the real case: cada 5 minutos ve diciéndome", () => {
    const parsed = parseLoopCommand("cada 5 minutos ve diciéndome")
    expect(parsed).toMatchObject({ ok: true, natural: true, when: "every 5m", strict: "every 5m ve diciéndome" })
    expect(parsed.ok && parsed.spec.trigger).toEqual({ kind: "interval", everyMs: 300_000 })
    expect(parsed.ok && parsed.spec.objective).toBe("ve diciéndome")
  })

  test.each([
    ["cada 5 minutos revisa el CI", "every 5m", "revisa el CI"],
    ["cada hora revisa el CI", "every 1h", "revisa el CI"],
    ["cada 2 horas revisa el CI", "every 2h", "revisa el CI"],
    ["cada media hora revisa el CI", "every 30m", "revisa el CI"],
    ["cada cuarto de hora revisa el CI", "every 15m", "revisa el CI"],
    ["cada minuto di hola", "every 1m", "di hola"],
    ["cada dos días limpia los logs", "every 2d", "limpia los logs"],
    ["cada semana resume los PRs", "every 7d", "resume los PRs"],
    ["revisa el CI cada 10 minutos", "every 10m", "revisa el CI"],
    ["cada diez minutos y avísame", "every 10m", "avísame"],
    ["todos los días a las 9 revisa los issues", "daily 09:00", "revisa los issues"],
    ["todos los días a las 18:30 resume el día", "daily 18:30", "resume el día"],
    ["cada día a las 9 de la noche haz backup", "daily 21:00", "haz backup"],
    ["cada día revisa los issues", "every 1d", "revisa los issues"],
    ["every five minutes tell me what changed", "every 5m", "tell me what changed"],
    ["every 5 minutes tell me what changed", "every 5m", "tell me what changed"],
    ["every minute say hi", "every 1m", "say hi"],
    ["every hour check CI", "every 1h", "check CI"],
    ["every half hour check CI", "every 30m", "check CI"],
    ["every 2 hrs check CI", "every 2h", "check CI"],
    ["check CI every 10 minutes", "every 10m", "check CI"],
    ["hourly check CI", "every 1h", "check CI"],
    ["daily at 9am check the issues", "daily 09:00", "check the issues"],
    ["daily at 9:30pm check the issues", "daily 21:30", "check the issues"],
    ["every day at 18:00 summarize", "daily 18:00", "summarize"],
    ["weekly review the roadmap", "every 7d", "review the roadmap"],
  ])("%s", (phrase, trigger, rest) => {
    expect(schedule(phrase)).toEqual({ trigger, rest })
  })

  test("a phrase can carry the strict flags after the schedule", () => {
    const parsed = parseLoopCommand("cada 10 minutos --goal arregla los tests until: pasan")
    expect(parsed).toMatchObject({ ok: true, natural: true })
    expect(parsed.ok && parsed.spec.budget).toEqual({ mode: "goal" })
    expect(parsed.ok && parsed.spec.criteria).toBe("pasan")
  })

  test("no schedule runs adaptive, 10m to start, and asks for the confirmation", () => {
    const parsed = parseLoopCommand("ve diciéndome cuando termine la sesión")
    expect(parsed).toMatchObject({ ok: true, natural: true, when: expect.stringContaining("adaptive 10m") })
    expect(parsed.ok && parsed.spec.trigger).toMatchObject({ kind: "adaptive", everyMs: 600_000 })
    expect(parsed.ok && parsed.spec.objective).toBe("ve diciéndome cuando termine la sesión")
    expect(parseLoopCommand("adaptive 30m watch the deploy")).toMatchObject({ ok: true, spec: { trigger: { kind: "adaptive", everyMs: 1_800_000 } } })
    expect(parseLoopCommand("adaptive watch the deploy")).toMatchObject({ ok: true, spec: { trigger: { kind: "adaptive", everyMs: 600_000 }, objective: "watch the deploy" } })
  })

  test("the strict form is unchanged and starts without a confirmation", () => {
    const parsed = parseLoopCommand("every 30m check ci")
    expect(parsed.ok && parsed.natural).toBeUndefined()
    expect(parsed).toMatchObject({ ok: true, summary: "loop: every 30m · monitor", when: "every 30m", budgetText: "monitor" })
    expect(parseLoopCommand("daily 09:00 review")).toMatchObject({ ok: true, spec: { trigger: { kind: "daily", at: "09:00" } } })
    expect(parseLoopCommand("now say hi")).toMatchObject({ ok: true, spec: { runNow: true } })
  })

  test("seconds, a missing objective and out-of-range spans are refused with a reason", () => {
    expect(parseLoopCommand("cada 30 segundos di hola")).toMatchObject({ ok: false, error: expect.stringContaining("1m to 30d") })
    expect(parseLoopCommand("cada 90 días haz algo")).toMatchObject({ ok: false, error: expect.stringContaining("1m to 30d") })
    expect(parseLoopCommand("cada 5 minutos")).toMatchObject({ ok: false, error: "/loop needs an objective" })
  })

  test("a schedule the parser does not know is handed to the small role", () => {
    expect(parseLoopCommand("cada tercer jueves revisa facturas")).toMatchObject({ ok: false, interpret: "cada tercer jueves revisa facturas" })
    expect(parseLoopCommand("todos los lunes a las 9 revisa")).toMatchObject({ ok: false, interpret: expect.any(String) })
    expect(parseLoopCommand("every other tuesday check invoices")).toMatchObject({ ok: false, interpret: expect.any(String) })
  })

  test("words that merely contain a schedule word do not trigger the small role", () => {
    expect(parseLoopCommand("fix every failing test")).toMatchObject({ ok: true, natural: true })
    expect(parseLoopCommand("revisa cada commit nuevo")).toMatchObject({ ok: true, natural: true })
  })
})
