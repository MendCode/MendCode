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
    "computer", "computer-sessions", "computer-native", "computer-accessibility", "computer-program",
    "browser", "browser-cdp", "browser-scripts", "setup-import", "debug-db", "diagnostics",
    "git-commit", "git-init", "git-push", "git-publish", "git-pr",
    "pr-review/already-reviewed",
    "pr-review/context", "pr-review/readers", "pr-review/readers-graft",
    "extensions/plugin-adapter", "extensions/plugin-tool", "extensions/session-api", "extensions/dialogs",
  ]) expect(inputs.has(`packages/daemon/src/${file}.ts`), file).toBe(false)
}, 20_000)
