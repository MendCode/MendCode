import { expect, test } from "bun:test"
import { UNSURE_LINE, messageLanguage, replyLanguageLine } from "../src/reply-language"

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

test("a named language holds whatever the message is in", () => {
  expect(replyLanguageLine("Español", "Fix the failing test and tell me what changed")).toBe("Reply in Español.")
  expect(replyLanguageLine(" English ", "arregla el test")).toBe("Reply in English.")
  expect(replyLanguageLine("AUTO", "ok")).toBe(UNSURE_LINE)
})
