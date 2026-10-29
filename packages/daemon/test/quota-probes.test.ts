import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelEvent, ModelRequest } from "@mendcode/engine-native"
import type { ModelInfo } from "@mendcode/protocol"
import { estimateTokens } from "@mendcode/protocol/wire"
import { PROBE_MAX_OUTPUT_TOKENS, PROBE_PROMPT, PROBE_SYSTEM, cheapestModel, claudeCodeProbe, codexAppServerProbe, nativeCodexProbe, nativeProbeRequest, quotaProbeDir } from "../src/quota-probes"

const models: ModelInfo[] = [
  { id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "medium", "high"] },
  { id: "gpt-6-luna", name: "Luna", efforts: ["minimal", "low", "medium"] },
  { id: "gpt-6-mini", name: "Mini", efforts: [] },
]

const headers = () => new Headers({ "x-codex-primary-used-percent": "12", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "1791036000", "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080", "x-codex-plan-type": "plus" })
const signal = () => new AbortController().signal

describe("native ChatGPT probe", () => {
  test("the request is one short message with no tools and a 16-token answer, not stored with a cache key", () => {
    const request = nativeProbeRequest({ model: "gpt-6-luna", effort: "minimal", signal: signal() })
    expect(request.tools).toEqual([])
    expect(request.hostedTools).toBeUndefined()
    expect(request.messages).toEqual([{ role: "user", content: PROBE_PROMPT }])
    expect(request.maxOutputTokens).toBe(PROBE_MAX_OUTPUT_TOKENS)
    expect(request.cacheKey).toBeUndefined()
    expect(request.cacheMode).toBe("off")
    expect(request.system).toBe(PROBE_SYSTEM)
    expect(request.nativeContext).toBeUndefined()
  })

  test("what one probe sends is a few tokens: the prompt, the system line and at most 16 back", () => {
    const sent = estimateTokens(PROBE_SYSTEM.length) + estimateTokens(PROBE_PROMPT.length)
    expect(sent).toBeLessThanOrEqual(10)
    expect(sent + PROBE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(26)
  })

  test("it picks the cheapest model of the catalogue by name and the lowest effort that model takes", async () => {
    expect(cheapestModel(models)).toBe("gpt-6-luna")
    expect(cheapestModel([{ id: "gpt-6.1-sol" }])).toBeUndefined()
    const seen: ModelRequest[] = []
    const probe = nativeCodexProbe({
      models: () => models, now: () => 9,
      provider: (onHeaders) => ({ async *stream(request) { seen.push(request); onHeaders(headers()); yield { type: "finish", reason: "stop" } as ModelEvent } }),
    })
    const reported: any[] = []
    await probe({ signal: signal(), report: (snapshot) => reported.push(snapshot) })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.model).toBe("gpt-6-luna")
    expect(seen[0]!.effort).toBe("minimal")
    expect(seen[0]!.tools).toEqual([])
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ provider: "codex", plan: "plus", fetchedAt: 9, windows: [{ label: "5h", usedPercent: 12 }, { label: "7d", usedPercent: 40 }] })
  })

  test("the user's model wins; an API-key provider's model is refused before anything is sent", async () => {
    const seen: ModelRequest[] = []
    const probe = nativeCodexProbe({ models: () => models, now: () => 0, provider: (onHeaders) => ({ async *stream(request) { seen.push(request); onHeaders(headers()); yield { type: "finish", reason: "stop" } as ModelEvent } }) })
    await probe({ model: "gpt-6.1-sol", signal: signal(), report: () => {} })
    expect(seen[0]!.model).toBe("gpt-6.1-sol")
    await expect(probe({ model: "openai:gpt-5", signal: signal(), report: () => {} })).rejects.toThrow(/not a ChatGPT model/)
    expect(seen).toHaveLength(1)
  })

  test("a response without rate-limit headers is a failure", async () => {
    const probe = nativeCodexProbe({ models: () => models, now: () => 0, provider: () => ({ async *stream() { yield { type: "finish", reason: "stop" } as ModelEvent } }) })
    await expect(probe({ signal: signal(), report: () => {} })).rejects.toThrow(/no rate-limit headers/)
  })

  test("a refused request surfaces its error to the schedule (a login that expired, a usage limit)", async () => {
    const probe = nativeCodexProbe({ models: () => models, now: () => 0, provider: () => ({ async *stream() { throw new Error("[PROVIDER]: 401") } }) })
    await expect(probe({ signal: signal(), report: () => {} })).rejects.toThrow("401")
  })
})

const dataDirs: string[] = []
afterEach(() => { for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dataDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-qprobe-")))
  dataDirs.push(dir)
  return dir
}

describe("the probe directory", () => {
  test("it is an empty private folder inside the data dir, created on first use", () => {
    const data = dataDir()
    const dir = quotaProbeDir(data)
    expect(dir).toBe(path.join(data, "quota-probe"))
    expect(readdirSync(dir)).toEqual([])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(quotaProbeDir(data)).toBe(dir)
  })
})

describe("Claude Code probe", () => {
  test("Haiku by default, the user's model when named, and the windows go to report", async () => {
    const calls: Array<{ model: string; cwd: string; bin: string }> = []
    const probe = claudeCodeProbe({ bin: "claude", dataDir: dataDir(), run: async (input) => { calls.push({ model: input.model, cwd: input.cwd, bin: input.bin }); input.onQuota({ type: "quota.snapshot", provider: "claude", windows: [], fetchedAt: 1 } as any) } })
    const reported: any[] = []
    await probe({ signal: signal(), report: (snapshot) => reported.push(snapshot) })
    await probe({ model: "claude-sonnet", signal: signal(), report: () => {} })
    expect(calls.map((call) => call.model)).toEqual(["haiku", "sonnet"])
    expect(reported).toHaveLength(1)
  })

  test("the process starts in the probe directory of the data dir, never in a project or the daemon's folder", async () => {
    const data = dataDir()
    const cwds: string[] = []
    const probe = claudeCodeProbe({ bin: "claude", dataDir: data, run: async (input) => { cwds.push(input.cwd) } })
    await probe({ signal: signal(), report: () => {} })
    expect(cwds).toEqual([path.join(data, "quota-probe")])
    expect(cwds[0]).not.toBe(process.cwd())
    expect(statSync(cwds[0]!).isDirectory()).toBe(true)
  })
})

describe("Codex app-server probe", () => {
  test("asks the app server for its rate limits, with no model, from the probe directory", async () => {
    const data = dataDir()
    const calls: Array<{ bin: string; cwd: string }> = []
    const probe = codexAppServerProbe({ bin: "codex", dataDir: data, run: async (input) => { calls.push({ bin: input.bin, cwd: input.cwd }) } })
    await probe({ signal: signal(), report: () => {} })
    expect(calls).toEqual([{ bin: "codex", cwd: path.join(data, "quota-probe") }])
  })
})
