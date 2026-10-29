import { afterEach, expect, test } from "bun:test"
import { inlineTexts, pastedText } from "@mendcode/protocol"
import { boot, openSession, stop, until, type NativeHarness } from "./native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

test("a long paste sent as a text attachment reaches the native model whole, where its label stands, in this turn and the next", async () => {
  h = await boot({ steps: [stop("read it"), stop("still have it")] })
  const sessionId = await openSession(h)
  const paste = `${"una línea del registro\n".repeat(5_000)}END-OF-PASTE`
  const put = await h.client.send({ type: "attachment.put", name: "paste-1.txt", data: Buffer.from(paste).toString("base64") })
  expect(put.ok).toBe(true)
  const attachment = (put as unknown as { result: { attachment: Record<string, unknown> } }).result.attachment
  const label = "[Pasted Content 115012 chars]"
  const text = `look at ${label} and tell me`
  const ack = await h.client.send({ type: "user.submit", sessionId, text, attachments: [{ ...attachment, label, at: `look at ${label}`.length } as never] })
  expect(ack.ok).toBe(true)
  await until(() => h!.requests.length === 1 && h!.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  const last = h.requests[0]!.messages.at(-1) as { layout?: Array<{ text?: string }> }
  const first = (last.layout ?? []).map((part) => part.text ?? "").join("")
  expect(first).toContain("END-OF-PASTE")
  // An adapter that reads only the text gets it too.
  expect((last as { content?: string }).content).toContain("END-OF-PASTE")
  expect(first.indexOf(label)).toBeLessThan(first.indexOf("END-OF-PASTE"))
  expect(first.indexOf("END-OF-PASTE")).toBeLessThan(first.indexOf("and tell me"))
  // The transcript keeps the short message; the next request still carries the paste from the attachment.
  await h.client.send({ type: "user.submit", sessionId, text: "and now?", attachments: [] })
  await until(() => h!.requests.length === 2)
  expect(JSON.stringify(h.requests[1]!.messages)).toContain("END-OF-PASTE")
})

test("for an engine that reads text, each text attachment goes back after its label; one whose label is gone goes at the end", () => {
  const bytes = new TextEncoder().encode("PASTED")
  const refs = [{ label: "[P1]", at: 7, mime: "text/plain" }, { mime: "image/png" }, { label: "[gone]", mime: "text/plain" }]
  const texts = new Map([[0, pastedText(bytes)], [2, pastedText(new TextEncoder().encode("LATE"))]])
  const out = inlineTexts("see [P1] then", refs, texts)
  expect(out.text).toBe("see [P1]\n<pasted>\nPASTED\n</pasted>\n then\n<pasted>\nLATE\n</pasted>\n")
  expect(out.refs).toEqual([{ mime: "image/png" }])
})
