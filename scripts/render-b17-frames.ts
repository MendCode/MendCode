import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { ModelInfo } from "@mendcode/protocol"
import { createFauxEngine } from "../packages/engine-faux/src"
import { createAuthStore, createMcpAuth, createMcpManager, loadMcpConfig } from "../packages/mcp/src"
import { startDaemon } from "../packages/daemon/src"
import { createProviderService } from "../packages/daemon/src/providers"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { catalogHarness, catalogPromptHarness, CATALOG_MCP } from "../apps/cli/test/catalog-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { editorRows } from "../apps/cli/src/view/editor"
import type { CatalogPrompt } from "../apps/cli/src/catalog-automation"

/** Real socket daemon and wizard factories, with temp data and scripted HTTP/auth only. */
export async function renderB17Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b17-frames-")), project = path.join(dir, "project")
  mkdirSync(project)
  const reports = new Map<string, string>()
  const prompts: Array<{ name: string; request: CatalogPrompt; answer: string }> = []
  const nativeModels: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272000 }, { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["medium", "high"] }]
  const providers = createProviderService({ dir, env: { TEAM_KEY: "fixture-only-never-print" }, fetch: async (url) => url.includes("/models")
    ? Response.json({ data: [{ id: "google/gemini-3-pro", context_length: 1000000, supported_parameters: ["reasoning"] }] })
    : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) })
  providers.set({ id: "openrouter", apiKeyEnv: "TEAM_KEY" })
  providers.set({ id: "ollama", models: [{ id: "llama3:8b" }] })
  const store = createAuthStore({ dir })
  await store.set("https://expired.example/mcp", { issuer: "https://auth.example", clientId: "fixture-client", tokenEndpoint: "https://auth.example/token", authMethod: "none", tokens: { accessToken: "fixture-token-never-print", expiresAt: 1, tokenType: "Bearer" } })
  const auth = createMcpAuth({ dir, store })
  const mcp = createMcpManager({ auth, configLoader: (directory) => loadMcpConfig({ directory, userDir: dir, env: {} }), fetch: async (url) => {
    if (url.startsWith("https://docs.example")) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://auth.example/resource"' } })
    if (url.endsWith("/resource")) return Response.json({ authorization_servers: ["https://auth.example"] })
    return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register", code_challenge_methods_supported: ["S256"] })
  } })
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), providers, mcp,
    info: { engine: "native", login: async () => ({ ok: true }) },
    models: { selectable: true, defaults: { model: "gpt-6-luna", effort: "medium" }, list: () => [...nativeModels, ...providers.models()] },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
  }).catch(async (error) => { await mcp.stop(); rmSync(dir, { recursive: true, force: true }); throw error })
  const client = createClient({ socketPath: daemon.socketPath, name: "B17 frames" })
  try {
    await client.connect()
    const run = async (name: string, args: string[], expected = 0) => {
      const parsed = parseAutomation(args)
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps: AutomationDeps = { client, cwd: project, now: Date.now, listen: () => {}, onInterrupt: () => {}, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } } }
      const code = await runAutomation(parsed.command, deps)
      if (code !== expected) throw new Error(`${name} exited ${code}: ${output}`)
      reports.set(name, output.split(dir).join("/tmp/b17-data"))
    }
    for (const [name, args] of [
      ["models", ["models"]], ["models-filtered", ["models", "ollama"]], ["models-verbose", ["models", "chatgpt", "--verbose"]], ["models-refresh", ["models", "openrouter", "--refresh"]],
      ...["status", "show", "plan", "presets"].map((operation) => [`models-${operation}`, ["control-plane", "models", operation]] as const),
      ["models-default-dry-run", ["control-plane", "models", "set-default", "openrouter", "google/gemini-3-pro", "--auth-mode", "api-key", "--dry-run"]],
      ["models-default", ["control-plane", "models", "set-default", "openrouter", "google/gemini-3-pro", "--auth-mode", "api-key"]],
      ["models-use-preset", ["control-plane", "models", "use-preset", "openai-codex-subscription-gpt-6-astra"]],
      ["providers", ["providers", "list"]],
      ...["auth", "status", "adapters", "smoke"].map((operation) => [`providers-${operation}`, ["control-plane", "providers", operation]] as const),
      ["providers-smoke-execute", ["control-plane", "providers", "smoke", "--provider", "openrouter", "--execute"]],
      ["providers-login", ["providers", "login", "--provider", "OpenRouter", "--api-key-env", "TEAM_KEY"]],
      ["mcp-add-local", ["mcp", "add", "tools", "--scope", "project", "--", "bun", "tools.ts"]],
      ["mcp-add-remote", ["mcp", "add", "docs", "--scope", "project", "--url", "https://docs.example/mcp"]],
      ["mcp-add-expired", ["mcp", "add", "expired", "--scope", "user", "--url", "https://expired.example/mcp"]],
      ["mcp-add-dry-run", ["mcp", "add", "preview", "--scope", "project", "--url", "https://preview.example/mcp", "--dry-run"]],
      ["mcp-list", ["mcp", "list"]], ["mcp-auth-list", ["mcp", "auth", "list"]], ["mcp-debug", ["mcp", "debug", "docs"]],
      ["mcp-status", ["control-plane", "mcp", "status"]], ["mcp-preview", ["control-plane", "mcp", "preview"]],
      ["mcp-control-add-local", ["control-plane", "mcp", "add-local", "other", "bun", "other.ts"]],
      ["mcp-logout", ["mcp", "logout", "expired"]],
    ] as const) await run(name, [...args])
    await run("models-refresh-subscription-blocked", ["models", "chatgpt", "--refresh"], 1)
    await run("models-unavailable-preset", ["control-plane", "models", "use-preset", "openai-api-gpt-5-nano"], 1)
    providers.set({ id: "openrouter", apiKey: "fixture-key-never-print" })
    await run("providers-logout", ["providers", "logout", "--provider", "openrouter"])

    for (const [name, args, answers] of [
      ["mcp-local-wizard", ["mcp", "add"], ["tools", "project", "local", "bun", '["tools with spaces.ts", "--flag"]']],
      ["mcp-remote-wizard", ["mcp", "add"], ["docs", "user", "remote", "https://docs.example/mcp", "yes", "registered-client", "CLIENT_SECRET"]],
      ["provider-login-wizard", ["providers", "login"], ["openrouter", "fixture-password"]],
      ["provider-logout-wizard", ["providers", "logout"], ["openrouter"]],
      ["mcp-logout-wizard", ["mcp", "logout"], ["expired"]],
    ] as const) {
      const h = catalogHarness({ prompts: [...answers] })
      if (await h.run([...args]) !== 0) throw new Error(h.err.join(""))
      h.prompts.forEach((request, index) => { prompts.push({ name: `${name}-${index + 1}`, request, answer: answers[index]! }) })
    }
    let authorized = false
    const h = catalogHarness({ prompts: ["docs"], send: (command) => {
      if (command.type === "mcp.status") return { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], state: authorized ? "running" : "stopped", auth: authorized ? "authorized" : "none" }] } }
      authorized = true
      return { ok: true, result: { url: "https://auth.example/authorize?state=fixture" } }
    } })
    if (await h.run(["mcp", "auth"]) !== 0) throw new Error(h.err.join(""))
    prompts.push({ name: "mcp-auth-select", request: h.prompts[0]!, answer: "docs" })
    reports.set("mcp-auth-complete", h.out.join(""))
    const reauth = catalogHarness({ prompts: ["yes"], send: (command) => command.type === "mcp.status"
      ? { ok: true, result: { issues: [], servers: [{ ...CATALOG_MCP.servers[1], state: "running", auth: "authorized" }] } }
      : { ok: true, result: { url: "https://auth.example/authorize?state=fixture" } } })
    if (await reauth.run(["mcp", "auth", "docs"]) !== 0) throw new Error(reauth.err.join(""))
    prompts.push({ name: "mcp-reauthenticate", request: reauth.prompts[0]!, answer: "yes" })

    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b")) || rows.join("\n").includes("never-print")) throw new Error(`invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = editorRows(output.trimEnd(), width).map((row) => row.text)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => fit([{ text: rows[page * height + row] ?? "" }], width).map((span) => span.text).join("")))
      }
      for (const { name, request, answer } of prompts) {
        const h = catalogPromptHarness({ ...request, initial: request.options ? "" : answer }, width, height)
        for (let i = 0; i < (request.options?.findIndex((option) => option.value === answer) ?? 0); i++) h.app.key("\x1b[B")
        save(name, h.text())
      }
      const invalid = catalogPromptHarness({ title: "Add MCP server", label: "Server name", validate: () => "Use letters, digits, . _ -", initial: "../bad" }, width, height)
      invalid.app.key("\r")
      save("mcp-name-invalid", invalid.text())
    }
  } finally {
    client.close()
    await daemon.stop()
    await mcp.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}
