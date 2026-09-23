import { describe, expect, test } from "bun:test"
import { contextProfile, contextReport, profileContext } from "../../src/session/context-profile"

describe("context profiles", () => {
  test("separates instructions, recalled memory, tool results and media without retaining content", () => {
    const secret = "PRIVATE_CONTENT_NOT_FOR_DIAGNOSTICS"
    const profile = profileContext({
      prompt: [
        { role: "system", content: "Stable instructions" },
        { role: "user", content: [{ type: "text", text: `${secret}<mendcode_memory>Remember conventions</mendcode_memory>` }] },
        { role: "tool", content: [{ type: "tool-result", output: { type: "content", value: [
          { type: "text", text: "A bounded result" },
          { type: "image-data", data: "A".repeat(100000), mediaType: "image/png" },
        ] } }] },
      ],
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    })
    expect(profile.imageCount).toBe(1)
    expect(profile.estimatedTokens.media).toBe(1500)
    expect(profile.estimatedTokens.instructions).toBeGreaterThan(0)
    expect(profile.estimatedTokens.memory).toBeGreaterThan(0)
    expect(profile.estimatedTokens.history).toBeGreaterThan(0)
    expect(profile.estimatedTokens.toolResults).toBeGreaterThan(0)
    expect(profile.estimatedTokens.toolSchemas).toBeGreaterThan(0)
    expect(JSON.stringify(profile)).not.toContain(secret)
    expect(JSON.stringify(profile)).not.toContain("AAAA")
  })

  test("fingerprints stable prefixes independently of changing conversation", () => {
    const profile = (text: string) => profileContext({ prompt: [
      { role: "system", content: "stable" }, { role: "user", content: text },
    ], tools: [{ name: "read" }] })
    expect(profile("one").instructionsFingerprint).toBe(profile("two").instructionsFingerprint)
    expect(profile("one").toolsFingerprint).toBe(profile("two").toolsFingerprint)
    expect(profileContext({ prompt: [], instructions: "OAuth instructions" }).estimatedTokens.instructions).toBeGreaterThan(0)
  })

  test("reports provider cache ratio and keeps missing usage unknown", () => {
    const profile = profileContext({ prompt: [] })
    const report = contextReport([{ info: { id: "message", role: "assistant" }, parts: [
      { type: "step-finish", metadata: { contextProfile: profile }, tokens: { input: 0, cache: { read: 0, write: 0 } } },
      { type: "step-finish", metadata: { contextProfile: { ...profile, usageReported: { input: true, cacheRead: true, cacheWrite: true } } }, tokens: { input: 200, cache: { read: 700, write: 100 } }, cost: 0.01 },
    ] }])
    expect(report.requests[0].inputTokens).toBeNull()
    expect(report.requests[0].cacheHitRate).toBeNull()
    expect(report.requests[1].inputTokens).toBe(1000)
    expect(report.requests[1].cacheHitRate).toBe(0.7)
    expect(contextProfile({ version: 1, estimatedTokens: {} })).toBeUndefined()
    expect(contextProfile({ ...profile, estimatedTokens: { ...profile.estimatedTokens, media: -1 } })).toBeUndefined()
  })
})
