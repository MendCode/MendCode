import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

type Metafile = { outputs: Record<string, { entryPoint?: string; inputs: Record<string, unknown>; imports: { path: string; kind: string }[] }> }

// Build only: neither entry point is executed, and no daemon, login or browser is started.
test("optional daemon helpers stay outside the solo prompt's static chunks", async () => {
  const root = path.resolve(import.meta.dir, "../../..")
  mkdirSync(path.join(root, "dist/probe"), { recursive: true })
  const dir = mkdtempSync(path.join(root, "dist/probe/graph-test-"))
  let meta: Metafile
  try {
    const result = Bun.spawnSync([process.execPath, "build", "--splitting", "--minify", "--target=bun", `--metafile=${dir}/meta.json`, "--outdir", `${dir}/split`, "apps/cli/src/entry.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as Metafile
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // Dynamic roots actually loaded for a solo terminal, not every optional command/page.
  const roots = new Set([
    "apps/cli/src/entry.ts", "apps/cli/src/main.ts", "packages/daemon/src/main.ts", "apps/cli/src/solo.ts",
    "apps/cli/src/ui/app.ts", "apps/cli/src/ui/screen.ts", "apps/cli/src/ui/keyboard-protocol.ts",
    "apps/cli/src/ui/keyboard-layout.ts", "apps/cli/src/ui/crash.ts", "apps/cli/src/ui/theme.ts",
    "apps/cli/src/ui/theme-files.ts", "apps/cli/src/view/transcript.ts", "apps/cli/src/view/accessible.ts",
  ])
  const seen = new Set<string>()
  const inputs = new Set<string>()
  function visit(file: string) {
    const output = meta.outputs[file]
    if (!output || seen.has(file)) return
    seen.add(file)
    Object.keys(output.inputs).forEach((input) => inputs.add(input))
    output.imports.filter((edge) => edge.kind !== "dynamic-import").forEach((edge) => visit(edge.path))
  }
  Object.entries(meta.outputs).filter(([, output]) => output.entryPoint && roots.has(output.entryPoint)).forEach(([file]) => visit(file))
  expect(inputs.has("packages/daemon/src/daemon.ts")).toBe(true)
  expect(inputs.has("apps/cli/src/ui/app.ts")).toBe(true)
  for (const file of [
    "computer", "computer-sessions", "computer-native", "computer-accessibility", "computer-program", "computer-tree",
    "browser", "browser-cdp", "browser-scripts", "setup-import", "debug-db", "diagnostics",
    "git-commit", "git-init", "git-push", "git-publish", "git-pr",
    "pr-review/already-reviewed", "pr-review/commit-status", "pr-review/pr-states",
    "pr-review/context", "pr-review/readers", "pr-review/readers-graft",
    "extensions/plugin-adapter", "extensions/plugin-tool", "extensions/session-api", "extensions/dialogs", "usage-breakdown",
    "restart-drain", "reply-language",
    // Memory review loads at the first turn with generation on, a waiting job or the Extraction tab.
    "memory-extraction",
    // Experimental bots (off by default): the service loads with the first bot command, the memory reader with the first turn that runs with the flag on.
    // bot-learn (its notes, skills and schedules) loads with the same first turn; bot-tools stays plain schemas.
    "bot-service", "bot-memory", "bot-recall", "bot-learn",
    // Session sync (off by default) loads only with sync.json or sync-hub.json in the data dir, or the first sync command.
    "sync/index", "sync/device", "sync/hub", "sync/ingest", "sync/config", "sync/projects", "sync/memories", "sync-blobs", "project-identity",
    // Configuration parity with a hub loads with the first `config.parity` command or the first round of a device that follows.
    "parity", "config-bundle/export", "config-bundle/plan", "config-bundle/apply",
    // The Hermes bot connector loads with the first `bot.list` that runs with the flag on; main.ts holds only its lazy stub (bot-connector-agents).
    "bot-hermes",
  ]) expect(inputs.has(`packages/daemon/src/${file}.ts`), file).toBe(false)
  // The graph's answer for a text search: its parser loads with the first grep or rg a model runs, the rest with the first one that names identifiers.
  for (const file of ["search-terms", "search-hint", "cache-name", "indexer", "query"]) expect(inputs.has(`packages/codegraph/src/${file}.ts`), file).toBe(false)
  // Bot faces (text, generated picture, avatar check and frame clock) load when a bot is drawn, never at start.
  for (const file of ["apps/cli/src/ui/app/bots.ts", "apps/cli/src/view/bot.ts", "apps/cli/src/view/bot-face.ts", "apps/cli/src/view/bot-face-image.ts", "apps/cli/src/view/bot-face-anim.ts", "apps/cli/src/view/bot-avatar.ts"]) expect(inputs.has(file), file).toBe(false)
  // The bots sidebar (all projects, bots section, icons column, a bot's page) loads with the first frame that needs it.
  for (const file of ["apps/cli/src/ui/app/sidebar-bots.ts", "apps/cli/src/view/sidebar-multi.ts", "apps/cli/src/view/bot-icon.ts", "apps/cli/src/view/bot-look.ts", "apps/cli/src/view/bot-card-page.ts"]) expect(inputs.has(file), file).toBe(false)
  // A plain terminal launch never evaluates the headless run, the herdr/tuios reporters (only inside such a pane), the completion script or the session export.
  for (const file of ["run", "herdr", "support-output", "export", "automation", "remote-setup", "remote-setup-projects", "sync-automation", "remote-code"]) expect(inputs.has(`apps/cli/src/${file}.ts`), file).toBe(false)
  expect(inputs.has("packages/store/src/sync-state.ts")).toBe(false)
  // Domain mode (off by default): the gateway package loads only for `gateway …`, device pairing for `remote login|logout`
  // or an HTTPS attach with a saved pairing, and the daemon's HTTP Unix socket only with `--unix-socket`.
  for (const file of ["cli", "server", "webauthn", "cbor", "setup", "units", "page", "device-key", "state", "audit"]) expect(inputs.has(`packages/gateway/src/${file}.ts`), file).toBe(false)
  expect(inputs.has("apps/cli/src/gateway-login.ts")).toBe(false)
  expect(inputs.has("packages/daemon/src/http-socket.ts")).toBe(false)
  // The prompt's vim layer loads with the first frame or key that has the vimMode setting on.
  expect(inputs.has("apps/cli/src/view/vim.ts")).toBe(false)
  expect(inputs.has("apps/cli/src/ui/app/vim-lazy.ts") || inputs.has("apps/cli/src/view/vim-lazy.ts")).toBe(true)
  // The left list's search (index, matcher, drawing and keys) loads with the first `/` or `sidebar.search`.
  for (const file of ["apps/cli/src/ui/app/sidebar-search.ts", "apps/cli/src/view/sidebar-search.ts"]) expect(inputs.has(file), file).toBe(false)
  // The folder picker of a new chat loads with the first `N`, `+ New chat…` or bot `+`; a bot's activity page with the first one opened.
  for (const file of ["apps/cli/src/ui/app/new-chat-picker.ts", "apps/cli/src/view/new-chat-picker.ts", "apps/cli/src/ui/app/bot-activity.ts"]) expect(inputs.has(file), file).toBe(false)
  // The bots listed on the home screen load with the first home frame that has the flag on.
  for (const file of ["apps/cli/src/ui/app/home-bots.ts", "apps/cli/src/view/home-bots.ts"]) expect(inputs.has(file), file).toBe(false)
  // The compaction panel, its arcade and every game load with the first compaction that shows them.
  for (const file of ["compaction-live", "compaction-arcade", "arcade/pixels", "arcade/snake", "arcade/breakout", "arcade/game2048", "arcade/blocks", "arcade/mines", "arcade/pong", "arcade/cycles", "arcade/glide", "arcade/stars", "arcade/crossing"]) expect(inputs.has(`apps/cli/src/view/${file}.ts`), file).toBe(false)
  // /usage's breakdown views load with the page or the `usage`/`stats` command.
  expect(inputs.has("apps/cli/src/view/usage-breakdown.ts")).toBe(false)
  // /profiles and what it names of an override (labels, groups, summaries) load with the page.
  for (const file of ["packages-page", "profile-overrides", "customize-rows"]) expect(inputs.has(`apps/cli/src/view/${file}.ts`), file).toBe(false)
  // /sessions draws and takes keys from its own module, loaded when the page opens.
  expect(inputs.has("apps/cli/src/view/sessions-page.ts")).toBe(false)
  // /today's controller loads with its first command; the daemon's brief, rules and file with the first `today.open` or Today turn.
  for (const file of ["apps/cli/src/ui/app/today.ts", "packages/daemon/src/today.ts"]) expect(inputs.has(file), file).toBe(false)
  // /marketplace's controller, keys and drawing load with the page; what a profile would take over loads with the first preview.
  for (const file of ["apps/cli/src/view/marketplace-page.ts", "apps/cli/src/ui/app/marketplace-controller.ts", "apps/cli/src/ui/app/marketplace-takeover.ts", "apps/cli/src/extensions/activation.ts"]) expect(inputs.has(file), file).toBe(false)
  // The pet system and the built-in MendGirl (module and sheet) load with the pet list or a chosen pet, never at start.
  for (const file of ["packages/daemon/src/channels-bridge.ts", "packages/daemon/src/channels-format.ts", "packages/daemon/src/channels-discord.ts"]) expect(inputs.has(file), file).toBe(false)
  for (const file of ["apps/cli/src/pets/builtin.ts", "apps/cli/src/pets/manifest.ts", "apps/cli/src/pets/sprite.ts", "apps/cli/assets/pets/mendgirl.webp"]) expect(inputs.has(file), file).toBe(false)
}, 20_000)
