import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { UNSURE_LINE, createReplyLanguage, isMachineNotice, messageLanguage, replyLanguageLine } from "../src/reply-language"

test("the standalone Codex constructor receives the daemon's reply-language callback", () => {
  // Importing main starts a daemon. Check its constructor wiring without starting services;
  // engine-codex/test/engine.test.ts covers the callback's effect on turn input.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
  const standalone = main.split('? createCodexEngine!({')[1]?.split(': createFauxEngine!')[0]
  expect(standalone).toBeDefined()
  expect(standalone).toMatch(/^\s*replyLanguage\s*,/m)
})

test("auto names the language of the user's latest message: Spanish, English, Portuguese, French", () => {
  expect(replyLanguageLine(undefined, "Arregla el test que falla y dime qué cambió en la sesión")).toBe("Reply in Spanish.")
  expect(replyLanguageLine("auto", "Fix the failing test and tell me what changed in the session")).toBe("Reply in English.")
  expect(messageLanguage("Você pode corrigir o teste que está falhando?")).toBe("Portuguese")
  expect(messageLanguage("Peux-tu corriger le test qui échoue dans la session ?")).toBe("French")
})

test("short chat messages are judged by a few distinctive words", () => {
  expect(messageLanguage("dime en spanish")).toBe("Spanish")
  expect(messageLanguage("sí, hazlo")).toBe("Spanish")
  expect(messageLanguage("merci")).toBe("French")
  expect(messageLanguage("thanks, go on")).toBe("English")
})

test("unclear, mixed or code-only text asks for the user's own language without naming one", () => {
  expect(replyLanguageLine(undefined, "ok")).toBe(UNSURE_LINE)
  expect(replyLanguageLine(undefined, "`bun test packages/a.ts`")).toBe(UNSURE_LINE)
  expect(replyLanguageLine(undefined, "gracias, thanks")).toBe(UNSURE_LINE)
})

test("per session: a notice from the engine and an unclear message keep the user's last language", () => {
  const line = createReplyLanguage()
  expect(line("s1", undefined, "arregla el test que falla y dime qué cambió")).toBe("Reply in Spanish.")
  // Claude Code's own wake-up after a Monitor ends is an English tagged block; it does not move the replies to English.
  expect(line("s1", undefined, "<task-notification><task-id>b1</task-id><summary>Monitor stream ended</summary></task-notification>")).toBe("Reply in Spanish.")
  expect(line("s1", undefined, "rename tu title chat para que otro agente te de instrucciones de como hacerlo")).toBe("Reply in Spanish.")
  expect(line("s1", undefined, "ok")).toBe("Reply in Spanish.")
  // The user switching language is followed, and another session starts with nothing kept.
  expect(line("s1", undefined, "Fix the failing test and tell me what changed in the session")).toBe("Reply in English.")
  expect(line("s2", undefined, "<task-notification><summary>done</summary></task-notification>")).toBe(UNSURE_LINE)
  expect(isMachineNotice("[Image #2] no se entiende")).toBe(false)
  // A user's own request wrapped in a tag is the user's words: its language is followed and kept.
  expect(isMachineNotice("<request>Arregla el test que falla y dime qué cambió en la sesión</request>")).toBe(false)
  expect(line("s1", undefined, "<request>Arregla el test que falla y dime qué cambió en la sesión</request>")).toBe("Reply in Spanish.")
})

test("a Spanish message mixed with English words is never named French for its \"tu\"", () => {
  // The full lists tie Spanish and Portuguese here; the short words may only choose among those, so the line names none.
  expect(replyLanguageLine(undefined, "rename tu title chat para que otro agente te de instrucciones de como hacerlo")).toBe(UNSURE_LINE)
  expect(messageLanguage("tu peux le faire?")).toBe("French")
  expect(messageLanguage("ok pero toca probarlo no? como lo hago?")).toBe("Spanish")
})

test("a named language holds whatever the message is in", () => {
  expect(replyLanguageLine("Español", "Fix the failing test and tell me what changed")).toBe("Reply in Español.")
  expect(replyLanguageLine(" English ", "arregla el test")).toBe("Reply in English.")
  expect(replyLanguageLine("AUTO", "ok")).toBe(UNSURE_LINE)
})
