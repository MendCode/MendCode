import { expect, test } from "bun:test"
import { redactValue } from "../src/secrets"
import { sanitizeSession } from "../src/session-automation"
import { redactTranscriptValue } from "../src/session-transfer"

test("recursive redaction retains each caller's key policy and does not mutate input", () => {
  const value = { token: "ordinary", access_token: "ordinary", apiKey: "ordinary", nested: [{ password: "ordinary", count: 2, empty: null }], marker: "‹secret:1›", enabled: false }
  const before = structuredClone(value)
  expect(redactValue(value)).toEqual(before)
  expect(redactTranscriptValue(value)).toEqual(before)
  expect(sanitizeSession(value)).toEqual({ ...before, access_token: "[redacted]", apiKey: "[redacted]", nested: [{ password: "[redacted]", count: 2, empty: null }] })
  expect(redactValue(value, { keys: /^(apiKey|api_key|token|password|secret|authorization)$/i })).toEqual({ ...before, token: "[redacted]", apiKey: "[redacted]", nested: [{ password: "[redacted]", count: 2, empty: null }] })
  expect(value).toEqual(before)
})

test("transcripts redact credential-shaped keys; session and loop reports preserve keys", () => {
  const fake = "gh" + "p_" + "a".repeat(36)
  const value = { [fake]: [{ text: fake, marker: "‹secret:2›" }] }
  const transcript = redactTranscriptValue(value)
  expect(Object.keys(transcript)).not.toContain(fake)
  expect(JSON.stringify(transcript)).not.toContain(fake)
  expect(Object.keys(sanitizeSession(value))).toEqual([fake])
  expect(Object.keys(redactValue(value))).toEqual([fake])
  expect(JSON.stringify(Object.values(redactValue(value)))).not.toContain(fake)
  expect(Object.values(transcript)[0]).toMatchObject([{ marker: "‹secret:2›" }])
  expect(redactValue([null, undefined, 4, true])).toEqual([null, undefined, 4, true])
})
