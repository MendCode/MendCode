import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { ModelInfo, Settings } from "@mendcode/protocol"
import { createAcpAgents } from "@mendcode/engine-acp"
import { filteredCatalog, modelsReport } from "../src/models"
import { createProviderService } from "../src/providers"

/**
 * What a terminal asks the daemon for at startup (settings, the sidebar's cards, a session, the model list) never waits on an ACP
 * agent or a provider, and the model list costs the same whether the catalog holds ten models or the hundreds an ACP agent learned
 * (OpenCode offers ~140) and a provider lists. A listing used to read the stored settings once per model: with OpenCode registered
 * every `models.list` held the daemon for a quarter of a second, and every client's request queued behind it.
 */
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const learned = (count: number) => Array.from({ length: count }, (_, i) => ({ value: `zen/model-${i}`, name: `Zen Model ${i}` }))
const providerFile = (dir: string, count: number, baseUrl = "http://10.255.255.1:9/v1") => writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ providers: { corp: { type: "openai-compatible", baseUrl, apiKey: "sk-test-local-only", models: Array.from({ length: count }, (_, i) => ({ id: `corp-model-${i}` })) } } }), { mode: 0o600 })

describe("a catalog listing reads the settings a fixed number of times, however many models it holds", () => {
  function acpCatalog(count: number) {
    const dir = temp("mend-startup-acp-")
    writeFileSync(path.join(dir, "acp-agents.json"), JSON.stringify({ zen: { command: "zen-acp-not-installed" } }))
    writeFileSync(path.join(dir, "acp-models.json"), JSON.stringify({ zen: learned(count) }))
    let reads = 0
    const settings = (): Settings => { reads++; return { disabled_models: ["corp/nothing"] } }
    const agents = createAcpAgents({ dir })
    const base = { selectable: true, list: (): ModelInfo[] => [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] }, ...agents.models()], defaults: { model: "gpt-6-luna" } }
    // Two layers, as the daemon has them: the process's own catalog and the daemon's view of it.
    const catalog = filteredCatalog(filteredCatalog(base, settings), settings)
    return { catalog, reads: () => reads, reset: () => { reads = 0 } }
  }

  test("an ACP agent's learned models: one listing, its defaults and the models report cost the same at 1 model as at 500", () => {
    const counts = [1, 500].map((count) => {
      const { catalog, reads, reset } = acpCatalog(count)
      expect(catalog.list()).toHaveLength(count + 2)
      reset()
      catalog.list()
      const listing = reads()
      reset()
      void catalog.defaults
      catalog.allows?.("acp:zen")
      modelsReport({ engine: "native", catalog, roles: { main: { model: "gpt-6-luna" } }, sessionKnown: true })
      return { listing, report: reads() }
    })
    expect(counts[0]!.listing).toBe(2)
    expect(counts[1]).toEqual(counts[0]!)
  })

  test("a provider's model list: the provider service reads the settings per provider, not per model", () => {
    const counts = [1, 300].map((count) => {
      const dir = temp("mend-startup-providers-")
      providerFile(dir, count)
      let reads = 0
      const service = createProviderService({ dir, env: {}, settings: () => { reads++; return {} } })
      expect(service.models(true).filter((model) => model.provider === "corp")).toHaveLength(count)
      reads = 0
      service.models(true)
      return reads
    })
    expect(counts[1]).toBe(counts[0]!)
  })
})

describe("the daemon a terminal starts against, with a hung ACP agent and an unreachable provider", () => {
  test("settings, the sidebar, a new session and the model list answer at once, and the agent is never started", async () => {
    const root = temp("mend-startup-daemon-")
    const [dir, home, project] = ["data", "home", "project"].map((name) => path.join(root, name))
    for (const folder of [dir!, home!, project!]) mkdirSync(folder, { recursive: true })
    // An agent that never answers `initialize`, and leaves a mark if anything starts it.
    const marker = path.join(root, "agent-started")
    const agent = path.join(root, "hung-agent.ts")
    writeFileSync(agent, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")\nawait Bun.sleep(1e9)\n`)
    writeFileSync(path.join(dir!, "acp-agents.json"), JSON.stringify({ hung: { command: process.execPath, args: [agent] } }))
    writeFileSync(path.join(dir!, "acp-models.json"), JSON.stringify({ hung: learned(140) }))
    providerFile(dir!, 300)
    // A clean environment: a temp home (no real credentials or Claude Code), and nothing inherited from the session running the tests.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home!, TMPDIR: root, MENDCODE_V2_DIR: dir!, MENDCODE_CLAUDE: "0" }
    const daemon = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), "--dir", dir!, "--cwd", project!, "--local-transport", "unix"], { env, stdout: "pipe", stderr: "ignore" })
    cleanups.push(() => daemon.kill("SIGKILL"))
    const reader = daemon.stdout.getReader()
    const { value } = await reader.read()
    reader.releaseLock()
    const ready = JSON.parse(new TextDecoder().decode(value).split("\n")[0]!) as { socketPath: string }
    const client = createClient({ socketPath: ready.socketPath, name: "startup-test" })
    cleanups.push(() => client.close())
    await client.connect()
    const timed = async (command: Parameters<typeof client.send>[0]) => {
      const started = performance.now()
      const reply = await client.send(command)
      return { reply, ms: performance.now() - started }
    }
    const created = await timed({ type: "session.create", directory: project! })
    expect(created.reply.ok).toBe(true)
    const result = <T>(reply: Awaited<ReturnType<typeof client.send>>) => (reply.ok ? reply.result : undefined) as T
    const sessionId = result<{ sessionId: never }>(created.reply).sessionId
    const answers = await Promise.all([timed({ type: "settings.get" }), timed({ type: "sidebar.get", directory: project! }), timed({ type: "models.list", sessionId })])
    for (const { reply } of answers) expect(reply.ok).toBe(true)
    const ids = result<{ models: ModelInfo[] }>(answers[2]!.reply).models.map((model) => model.id)
    expect(ids).toContain("acp:hung/zen/model-139")
    expect(ids).toContain("corp:corp-model-299")
    // Generous for a loaded test machine: a request that waited on the agent (60 s initialize limit) or the provider would be far past it.
    for (const { ms } of [created, ...answers]) expect(ms).toBeLessThan(2_000)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)
})
