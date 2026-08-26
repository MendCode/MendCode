import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

const installer = path.resolve(import.meta.dir, "../../../../install")
const roots: string[] = []

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mendcode-install-layout-"))
  roots.push(root)
  const home = path.join(root, "home")
  const data = path.join(root, "xdg-data")
  const tools = path.join(root, "tools")
  const binary = path.join(root, "mendcode-fixture")
  const setupLog = path.join(root, "setup.log")
  const archiveRoot = path.join(root, "archive")
  const zipArchive = path.join(root, "mendcode-darwin-arm64.zip")
  const tarArchive = path.join(root, "mendcode-linux-x64.tar.gz")
  mkdirSync(home, { recursive: true })
  mkdirSync(data, { recursive: true })
  mkdirSync(tools, { recursive: true })
  const binarySource =
    '#!/usr/bin/env bash\nprintf "%s|%s\\n" "${MENDCODE_GLOBAL_LAYOUT:-}" "${OPENCODE_ROUTE:-}" > "${MENDCODE_TEST_SETUP_LOG:?}"\n'
  writeFileSync(binary, binarySource)
  chmodSync(binary, 0o755)
  mkdirSync(archiveRoot)
  writeFileSync(path.join(archiveRoot, "mendcode"), binarySource)
  chmodSync(path.join(archiveRoot, "mendcode"), 0o755)
  expect(Bun.spawnSync({ cmd: ["zip", "-q", zipArchive, "mendcode"], cwd: archiveRoot }).exitCode).toBe(0)
  expect(Bun.spawnSync({ cmd: ["tar", "-czf", tarArchive, "mendcode"], cwd: archiveRoot }).exitCode).toBe(0)
  writeFileSync(
    path.join(tools, "uname"),
    '#!/usr/bin/env bash\ncase "${1:-}" in -m) printf "%s\\n" "${MENDCODE_TEST_ARCH:-x86_64}" ;; *) printf "%s\\n" "${MENDCODE_TEST_OS:-Linux}" ;; esac\n',
  )
  chmodSync(path.join(tools, "uname"), 0o755)
  writeFileSync(
    path.join(tools, "curl"),
    '#!/usr/bin/env bash\nout=""\nwhile (($#)); do\n  if [[ "$1" == "-o" ]]; then out=$2; shift 2; continue; fi\n  shift\ndone\nif [[ -n "$out" ]]; then cp "${MENDCODE_TEST_ARCHIVE:?}" "$out"; else printf \'{"tag_name":"v9.9.9"}\\n\'; fi\n',
  )
  chmodSync(path.join(tools, "curl"), 0o755)
  writeFileSync(path.join(tools, "launchctl"), "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(path.join(tools, "launchctl"), 0o755)
  return { root, home, data, tools, binary, setupLog, zipArchive, tarArchive }
}

function run(
  item: ReturnType<typeof fixture>,
  input: {
    donorLayout?: "legacy" | "mendcode"
    layout?: "legacy" | "mendcode"
    setup?: boolean
    shell?: string
    source?: "local" | "latest"
    platform?: "Linux" | "Darwin"
    arch?: "x86_64" | "arm64"
  } = {},
) {
  const env = { ...process.env }
  delete env.MENDCODE_GLOBAL_LAYOUT
  delete env.OPENCODE_GLOBAL_LAYOUT
  if (input.layout) env.MENDCODE_GLOBAL_LAYOUT = input.layout
  if (input.donorLayout) env.OPENCODE_GLOBAL_LAYOUT = input.donorLayout
  env.HOME = item.home
  env.XDG_DATA_HOME = item.data
  env.XDG_CONFIG_HOME = path.join(item.root, "xdg-config")
  env.XDG_STATE_HOME = path.join(item.root, "xdg-state")
  env.XDG_CACHE_HOME = path.join(item.root, "xdg-cache")
  env.SHELL = input.shell ?? "/bin/zsh"
  env.PATH = `${item.tools}:${process.env.PATH}`
  env.MENDCODE_TEST_SETUP_LOG = item.setupLog
  env.MENDCODE_TEST_OS = input.platform ?? "Linux"
  env.MENDCODE_TEST_ARCH = input.arch ?? "x86_64"
  env.MENDCODE_TEST_ARCHIVE = input.platform === "Darwin" ? item.zipArchive : item.tarArchive
  const sourceArgs = input.source === "latest" ? [] : ["--binary", item.binary]
  return Bun.spawnSync({
    cmd: [
      "bash",
      installer,
      ...sourceArgs,
      "--no-modify-path",
      input.setup ? "--setup" : "--skip-setup",
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
}

function selection(item: ReturnType<typeof fixture>) {
  return readFileSync(path.join(item.home, ".mendcode", ".global-layout-v1"), "utf8").trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("installer global layout", () => {
  test("separates a new MendCode install from existing external OpenCode data and scopes immediate setup", () => {
    const item = fixture()
    const legacy = path.join(item.data, "opencode")
    mkdirSync(legacy)
    writeFileSync(path.join(legacy, "opencode.db"), "external-opencode")

    const result = run(item, { setup: true })

    expect(result.exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
    expect(readFileSync(item.setupLog, "utf8").trim()).toBe('mendcode|{"type":"setup"}')
    expect(readFileSync(path.join(legacy, "opencode.db"), "utf8")).toBe("external-opencode")
    expect(readdirSync(legacy)).toEqual(["opencode.db"])
  })

  test("preserves a demonstrably MendCode-owned legacy layout", () => {
    const item = fixture()
    const legacy = path.join(item.data, "opencode")
    mkdirSync(legacy)
    writeFileSync(path.join(legacy, "mendcode.db"), "legacy-mendcode")

    const result = run(item, { setup: true })

    expect(result.exitCode).toBe(0)
    expect(selection(item)).toBe("legacy")
    expect(readFileSync(item.setupLog, "utf8").trim()).toBe('legacy|{"type":"setup"}')
    expect(readFileSync(path.join(legacy, "mendcode.db"), "utf8")).toBe("legacy-mendcode")
  })

  test("fails closed when an installed MendCode binary and generic legacy data are ambiguous", () => {
    const item = fixture()
    const installed = path.join(item.home, ".mendcode", "bin", "mendcode")
    const legacy = path.join(item.data, "opencode")
    mkdirSync(path.dirname(installed), { recursive: true })
    mkdirSync(legacy)
    writeFileSync(installed, "old-binary")
    chmodSync(installed, 0o755)
    writeFileSync(path.join(legacy, "opencode.db"), "ambiguous")

    const result = run(item)

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("Cannot safely identify")
    expect(readFileSync(installed, "utf8")).toBe("old-binary")
    expect(() => selection(item)).toThrow()
  })

  test("an explicit MendCode override resolves ambiguity and persists for future shells", () => {
    const item = fixture()
    const installed = path.join(item.home, ".mendcode", "bin", "mendcode")
    const legacy = path.join(item.data, "opencode")
    mkdirSync(path.dirname(installed), { recursive: true })
    mkdirSync(legacy)
    writeFileSync(installed, "old-binary")
    chmodSync(installed, 0o755)
    writeFileSync(path.join(legacy, "opencode.db"), "external-opencode")

    expect(run(item, { layout: "mendcode" }).exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
    expect(run(item).exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
    expect(readFileSync(path.join(legacy, "opencode.db"), "utf8")).toBe("external-opencode")
  })

  test.each(["/bin/bash", "/bin/zsh", "/opt/homebrew/bin/fish"])(
    "keeps layout selection independent of %s shell config and --no-modify-path",
    (shell) => {
      const item = fixture()
      const result = run(item, { shell })
      expect(result.exitCode).toBe(0)
      expect(selection(item)).toBe("mendcode")
      expect(readdirSync(item.home)).toEqual([".mendcode"])
    },
  )

  test("prefers an existing MendCode layout when both data roots exist", () => {
    const item = fixture()
    mkdirSync(path.join(item.data, "opencode"))
    mkdirSync(path.join(item.data, "mendcode"))
    writeFileSync(path.join(item.data, "opencode", "opencode.db"), "external")
    writeFileSync(path.join(item.data, "mendcode", "mendcode.db"), "mend")

    expect(run(item).exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
  })

  test("does not let an OpenCode shell variable redirect a new MendCode install", () => {
    const item = fixture()
    expect(run(item, { donorLayout: "legacy", setup: true }).exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
    expect(readFileSync(item.setupLog, "utf8").trim()).toBe('mendcode|{"type":"setup"}')
  })

  test.each([
    { platform: "Linux" as const, arch: "x86_64" as const },
    { platform: "Darwin" as const, arch: "arm64" as const },
  ])("selects the same persisted layout for latest-channel $platform/$arch installs", ({ platform, arch }) => {
    const item = fixture()
    mkdirSync(path.join(item.data, "opencode"))
    writeFileSync(path.join(item.data, "opencode", "opencode.db"), "external")

    const result = run(item, { source: "latest", platform, arch, setup: true })

    expect(result.exitCode).toBe(0)
    expect(selection(item)).toBe("mendcode")
    expect(readFileSync(item.setupLog, "utf8").trim()).toBe('mendcode|{"type":"setup"}')
  })
})
