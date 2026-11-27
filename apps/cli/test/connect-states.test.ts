import { describe, expect, test } from "bun:test"
import type { ProviderAuthStatus } from "@mendcode/protocol"
import { CONNECT_CHOICES, connectKey, connectWithAuth, createConnectState, renderConnectPage, type ConnectState } from "../src/view/connect-page"
import { plain, REPORT } from "./providers-harness"

const status = (provider: string, over: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({ provider, state: "none", source: "none", accessTokenPresent: false, refreshTokenPresent: false, accountIdPresent: false, ...over })
const page = (state: ConnectState, width = 80, height = 40, models: Parameters<typeof renderConnectPage>[0]["models"] = REPORT) => renderConnectPage({ state, width, height, models }).map(plain)

describe("/connect shows the real state of each sign-in", () => {
  test("subscriptions lead and API keys follow, under their own headings", () => {
    const rows = page(createConnectState())
    const text = rows.join("\n")
    expect(text.indexOf("Sign in with a subscription")).toBeLessThan(text.indexOf("ChatGPT"))
    expect(text.indexOf("GitHub Copilot")).toBeLessThan(text.indexOf("API keys and endpoints"))
    expect(text.indexOf("API keys and endpoints")).toBeLessThan(text.indexOf("OpenAI"))
    expect(text).not.toContain("Model catalogs")
    expect(rows.filter((row) => row.includes("ChatGPT"))).toHaveLength(1)
  })

  test("an expired imported ChatGPT login is not shown as fine: no check mark, a banner, and the cursor on it", () => {
    const expired = connectWithAuth(createConnectState(), [status("chatgpt", { state: "expired", imported: "codex", accessTokenPresent: true })])
    const rows = page(expired)
    const row = rows.find((line) => line.includes("(imported)"))!
    expect(row).toContain("expired (imported) · enter to sign in here")
    expect(row).not.toContain("✓")
    expect(rows.join("\n")).toContain("ChatGPT sign-in expired · select it and press enter to sign in again")
    expect(rows.every((line) => [...line].length <= 80)).toBe(true)
    expect(CONNECT_CHOICES[expired.selected]).toBe("chatgpt")
  })

  test("a working login says whose it is, and not signed in says so", () => {
    const own = page(connectWithAuth(createConnectState(), [status("chatgpt", { state: "authorized", source: "v2" })])).join("\n")
    expect(own).toMatch(/ChatGPT\s+\S+ signed in · MendCode login/)
    const imported = page(connectWithAuth(createConnectState(), [status("chatgpt", { state: "authorized", imported: "codex" })])).join("\n")
    expect(imported).toContain("signed in · login from another tool")
    const none = page(connectWithAuth(createConnectState(), [status("chatgpt", {}), status("github-copilot", {})]), 80, 40, undefined).join("\n")
    expect(none).toMatch(/ChatGPT\s+not signed in · enter to sign in/)
    expect(none).not.toContain("expired")
  })

  test("an expired Copilot login takes the cursor; the user's own move is kept", () => {
    const statuses = [status("github-copilot", { state: "expired", source: "v2" })]
    expect(CONNECT_CHOICES[connectWithAuth(createConnectState(), statuses).selected]).toBe("github-copilot")
    expect(connectWithAuth({ ...createConnectState(), selected: 5 }, statuses).selected).toBe(5)
    expect(page(connectWithAuth(createConnectState(), statuses)).join("\n")).toContain("GitHub Copilot sign-in expired")
  })

  test("Claude Code reads as ready when its models exist and as not found otherwise; enter explains instead of opening a form", () => {
    expect(page(createConnectState()).join("\n")).toMatch(/Claude Code\s+\S+ ready · 1 model/)
    const absent = page(createConnectState(), 80, 40, { ...REPORT, models: REPORT.models.filter((model) => model.engine !== "claude") }).join("\n")
    expect(absent).toMatch(/Claude Code\s+not found/)
    const opened = connectKey({ ...createConnectState(), selected: CONNECT_CHOICES.indexOf("claude-code") }, "\r")
    expect(opened.state.step).toBe("pick")
    expect(opened.action).toEqual({ type: "none" })
    expect(opened.state.info).toContain("`claude`")
    expect(createConnectState("claude-code").info).toContain("`claude`")
  })

  test("an expired ChatGPT row opens its sign-in methods, not an old session page", () => {
    const expired = connectWithAuth(createConnectState(), [status("chatgpt", { state: "expired", imported: "codex" })])
    const opened = connectKey(expired, "\r").state
    expect(opened.step).toBe("methods")
    expect(opened.target).toBe("chatgpt")
  })

  test("the page stays compact at 80 columns with a long list and the cursor far down", () => {
    const far = { ...createConnectState(), selected: CONNECT_CHOICES.length - 1 }
    const rows = page(far, 80, 24)
    expect(rows).toHaveLength(24)
    expect(rows.some((row) => row.includes("❯") && row.includes("OpenCode (free)"))).toBe(true)
    expect(rows.every((row) => [...row].length <= 80)).toBe(true)
  })
})
