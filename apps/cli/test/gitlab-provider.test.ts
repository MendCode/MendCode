import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createConnectState, connectKey, connectPaste, renderConnectPage, validateConnect, CONNECT_CHOICES } from "../src/view/connect-page"
import { presetOf } from "../src/view/provider-presets"
import { textWidth } from "../src/view/wrap"
import { PROVIDER_PRESETS } from "../../../packages/engine-native/src/provider-presets"
import { GITLAB_TOKEN, GITLAB_NAMESPACE, GITLAB_URL } from "../../../packages/engine-native/test/gitlab-fixtures"
import { gitlabHarness } from "./gitlab-harness"
import { plain } from "./providers-harness"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-20-cli-")); dirs.push(dir); return dir }
const submit = async (h: ReturnType<typeof gitlabHarness>) => {
  await h.run("/connect GitLab"); await h.type(GITLAB_URL); await h.type("\r"); await h.type(GITLAB_TOKEN); await h.type("\r"); await h.type(GITLAB_NAMESPACE); await h.type("\r")
}

describe("B10.20 GitLab terminal flow", () => {
  test("native and UI presets agree; provider append preserves existing numeric shortcuts", () => {
    expect(CONNECT_CHOICES.filter((id) => id === "gitlab")).toHaveLength(1)
    expect(CONNECT_CHOICES.indexOf("gitlab")).toBe(CONNECT_CHOICES.indexOf("zenmux") + 1)
    const { id: _id, ...ui } = presetOf("gitlab")!
    const { models, defaultEnabled, ...native } = PROVIDER_PRESETS.gitlab!
    expect(ui).toEqual(native)
    expect(defaultEnabled).toBe(false)
    expect(models.length).toBeGreaterThan(0)
    for (const [index, id] of CONNECT_CHOICES.slice(0, 9).entries()) expect(connectKey(createConnectState(), String(index + 1)).state.target).toBe(id)
  })

  test("masked token is saved once, catalog precedes test and models can be selected", async () => {
    const h = gitlabHarness({ dataDir: temp() })
    await submit(h)
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "gitlab", baseUrl: GITLAB_URL, apiKey: GITLAB_TOKEN, enabled: true, gitlab: { rootNamespaceId: GITLAB_NAMESPACE } }])
    expect(h.sent.filter((command) => ["providers.set", "providers.refresh", "providers.test"].includes(command.type as string)).map((command) => command.type)).toEqual(["providers.set", "providers.refresh", "providers.test"])
    expect(h.text()).toContain("GitLab connected")
    expect(h.everything()).not.toContain(GITLAB_TOKEN)
    expect(h.sent.filter((command) => command.type !== "providers.set").some((command) => JSON.stringify(command).includes(GITLAB_TOKEN))).toBe(false)
    await h.type("r"); expect(h.text()).toContain("tools use local permissions")
    await h.type("m"); expect(h.app.page).toBe("model")
    await h.type("/"); await h.type("gitlab:duo-chat-gpt-5-2"); await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "gitlab:duo-chat-gpt-5-2" } })
    await h.run("/model roles"); await h.type("/"); await h.type("gitlab:duo-workflow-sonnet-4-6"); await h.type("\r")
    expect(h.commands("session.model.set").at(-1)).toMatchObject({ choice: { model: "gitlab:duo-workflow-sonnet-4-6" } })
    expect(h.app.editor.text).toBe("")
  })

  test("environment mode and namespace validation never send an unsafe URL", () => {
    let state = connectKey(createConnectState("gitlab"), "\x05").state
    state = connectPaste(state, GITLAB_URL)
    expect(validateConnect(state)).toEqual({ ok: true, submit: { provider: "gitlab", baseUrl: GITLAB_URL, apiKeyEnv: "GITLAB_TOKEN", enabled: true, gitlab: {} } })
    for (const baseUrl of ["http://gitlab.com", "http://localhost.evil", "http://user:password@localhost", "http://localhost?token=secret", "http://localhost#x"]) expect(validateConnect({ ...state, values: { ...state.values, baseUrl } })).toMatchObject({ ok: false, focus: 0 })
    expect(validateConnect({ ...state, values: { ...state.values, rootNamespaceId: "123" } })).toMatchObject({ ok: false, focus: 1 })
    expect(renderConnectPage({ state, width: 100, height: 30 }).map(plain).join("\n")).toContain("GITLAB_TOKEN")
  })

  test("save, discovery and generation failures remain inline; refresh retry completes the flow", async () => {
    for (const phase of ["providers.set", "providers.refresh", "providers.test"]) {
      const h = gitlabHarness({ dataDir: temp() })
      h.fail(phase); await submit(h)
      expect(h.text()).toContain("403")
      expect(h.commands("providers.test")).toHaveLength(phase === "providers.test" ? 1 : 0)
      expect(h.everything()).not.toContain(GITLAB_TOKEN)
      if (phase === "providers.refresh") {
        expect(h.text()).toContain("r refresh models")
        h.fail(); await h.type("r")
        expect(h.commands("providers.refresh")).toHaveLength(2)
        expect(h.commands("providers.test")).toHaveLength(1)
        expect(h.text()).toContain("GitLab connected")
        expect(h.text()).not.toContain("refresh failed")
      }
      if (phase !== "providers.set") { await h.type("e"); expect(h.text()).toContain("Namespace"); expect(h.text()).toContain("Token") }
    }
  })

  test("provider settings disable live and removal requires confirmation", async () => {
    const h = gitlabHarness({ dataDir: temp() }); h.provider.enabled = true
    await h.run("/providers"); await h.type("\r"); expect(h.text()).toContain("duo-chat-sonnet-4-6")
    await h.type("\x1b"); await h.type("e")
    expect(h.commands("providers.set")).toEqual([{ type: "providers.set", provider: "gitlab", enabled: false }])
    await h.type("d"); expect(h.commands("providers.remove")).toHaveLength(0)
    await h.type("y"); expect(h.commands("providers.remove")).toHaveLength(1)
    expect(h.text()).toContain("No providers")
  })

  test("connection panels fit compact and wide terminals with header hints and visible focused fields", () => {
    const form = { ...createConnectState("gitlab"), values: { baseUrl: GITLAB_URL, key: GITLAB_TOKEN, models: "", name: "", rootNamespaceId: GITLAB_NAMESPACE } }
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const focus of [0, 1, 2]) {
      const rows = renderConnectPage({ state: { ...form, focus }, width: width!, height: height! }).map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows.join("\n")).not.toContain(GITLAB_TOKEN)
      expect(rows[0]).toContain("Connect")
      expect(rows.join("\n")).toContain(["GitLab URL", "Token", "Namespace"][focus]!)
      expect(rows.join("\n")).toContain("┌")
    }
  })

  test("GitLab stays lazy and the terminal startup graph never loads its adapter or schemas", () => {
    const result = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("@mendcode/client"); const keys = Object.keys(require.cache); const before = keys.some(key => key.endsWith("/view/connect-page.ts")); const pages = await import("./src/ui/lazy-pages"); await pages.preload("connect"); await pages.preload("providers"); const after = Object.keys(require.cache); console.log(JSON.stringify({ before, zod: after.filter(key => key.includes("/zod/")).length, gitlab: after.filter(key => key.endsWith("/engine-native/src/gitlab.ts") || key.endsWith("/protocol/src/gitlab.ts")).length }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString())).toEqual({ before: false, zod: 0, gitlab: 0 })
  })

  test("GitLab provider details use the shared panels at compact and wide sizes", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) {
      const h = gitlabHarness({ dataDir: temp(), width, height })
      await h.run("/providers"); await h.type("\r")
      const rows = h.frames.at(-1)!.map(plain)
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows.join("\n")).toContain("┌")
      expect(rows[0]).toContain("Providers")
      expect(rows.join("\n")).toContain("Workflow tools: local permissions")
      expect(rows.join("\n")).not.toContain(GITLAB_TOKEN)
    }
  })
})
