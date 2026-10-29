import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { platformAsset } from "../packages/upgrade/src/releases"
import { sha256Hex } from "../packages/upgrade/src/checksum"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const script = path.join(import.meta.dir, "install.sh")
const body = "#!/bin/sh\nprintf 'fake mendcode\\n'\n"
const hash = sha256Hex(new TextEncoder().encode(body))

function fixture(os = "Linux", arch = "x86_64", hashing = true, version = "1.2.3") {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-install-"))
  temps.push(dir)
  const tools = path.join(dir, "tools")
  const install = path.join(dir, "install dir")
  const release = path.join(dir, "release")
  mkdirSync(tools)
  const native = (name: string) => {
    const command = Bun.which(name)
    if (!command) throw new Error(`test requires ${name}`)
    symlinkSync(command, path.join(tools, name))
  }
  for (const name of ["curl", "awk", "grep", "sed", "mkdir", "mktemp", "rm", "chmod", "mv"]) native(name)
  if (hashing) native(Bun.which("sha256sum") ? "sha256sum" : "shasum")
  writeFileSync(path.join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$FAKE_OS" ;; -m) printf "%s\\n" "$FAKE_ARCH" ;; esac\n', { mode: 0o755 })
  const name = os === "Darwin" && arch === "arm64" ? platformAsset({ os: "darwin", arch: "arm64" }, `v${version}`)
    : `mendcode-${version}-${os === "Darwin" ? "darwin" : "linux"}-${["arm64", "aarch64"].includes(arch) ? "arm64" : "x64"}`
  const assets = path.join(release, "download", `v${version}`)
  mkdirSync(assets, { recursive: true })
  writeFileSync(path.join(assets, name), body)
  writeFileSync(path.join(assets, "SHA256SUMS"), `${hash}  ${name}\n`)
  const run = (extra: Record<string, string> = {}, args: string[] = []) => Bun.spawnSync(["/bin/sh", script, ...args], {
    env: { HOME: path.join(dir, "home"), PATH: tools, FAKE_OS: os, FAKE_ARCH: arch, MENDCODE_VERSION: version, MENDCODE_ALLOW_UNSIGNED: "1", MENDCODE_INSTALL_DIR: install, MENDCODE_DOWNLOAD_BASE: pathToFileURL(release).href, ...extra },
    stdout: "pipe", stderr: "pipe",
  })
  return { dir, tools, install, name, assets, run }
}

for (const [os, arch] of [["Darwin", "arm64"], ["Darwin", "x86_64"], ["Linux", "aarch64"], ["Linux", "x86_64"]] as const) {
  test(`POSIX installer installs verified ${os}-${arch} from file:// inside a temp install dir`, () => {
    const box = fixture(os, arch)
    const result = box.run()
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
    expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe(body)
    expect(statSync(path.join(box.install, "mendcode")).mode & 0o777).toBe(0o755)
    expect(readdirSync(box.install).sort()).toEqual([".mendcode-v2-install", "mendcode"])
    expect(readFileSync(path.join(box.install, ".mendcode-v2-install"), "utf8")).toBe(`schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${hash}\ntier=balanced\n`)
    expect(result.stdout.toString()).toContain("PATH")
    expect(existsSync(path.join(box.dir, "home"))).toBe(false)
  })
}

test("latest version resolves through a local release redirect without external requests", async () => {
  const box = fixture()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/latest") return Response.redirect(new URL("/tag/v1.2.3", request.url).href, 302)
      if (pathname === "/tag/v1.2.3") return new Response("local release")
      for (const name of [box.name, "SHA256SUMS"]) if (pathname === `/download/v1.2.3/${name}`) return new Response(Bun.file(path.join(box.assets, name)))
      return new Response("unexpected request", { status: 404 })
    },
  })
  let proc: ReturnType<typeof Bun.spawn> | undefined
  try {
    const running = Bun.spawn(["/bin/sh", script], {
      env: { HOME: path.join(box.dir, "home"), PATH: box.tools, FAKE_OS: "Linux", FAKE_ARCH: "x86_64", MENDCODE_INSTALL_DIR: box.install, MENDCODE_ALLOW_UNSIGNED: "1", MENDCODE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}` },
      stdout: "pipe", stderr: "pipe",
    })
    proc = running
    const [code, stderr] = await Promise.all([running.exited, new Response(running.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe(body)
    expect(existsSync(path.join(box.dir, "home"))).toBe(false)
  } finally {
    if (proc?.exitCode === null) { proc.kill(); await proc.exited }
    server.stop(true)
  }
})

test("a wrong checksum preserves the installed binary and cleans staging", () => {
  const box = fixture()
  mkdirSync(box.install)
  writeFileSync(path.join(box.install, "mendcode"), "previous")
  writeFileSync(path.join(box.assets, "SHA256SUMS"), `${"0".repeat(64)}  ${box.name}\n`)
  const result = box.run()
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("does not match")
  expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe("previous")
  expect(readdirSync(box.install)).toEqual(["mendcode"])
})

test("missing, malformed and duplicate checksums fail closed", () => {
  for (const sums of [`${hash}  other\n`, `bad  mendcode-1.2.3-linux-x64\n`, `${hash}  mendcode-1.2.3-linux-x64\n${hash} *mendcode-1.2.3-linux-x64\n`]) {
    const box = fixture()
    writeFileSync(path.join(box.assets, "SHA256SUMS"), sums)
    expect(box.run().exitCode).not.toBe(0)
    expect(readdirSync(box.install)).toEqual([])
  }
})

test("unknown OS or architecture is refused before creating the install dir", () => {
  for (const [os, arch] of [["FreeBSD", "x86_64"], ["Linux", "riscv64"]]) {
    const box = fixture(os, arch)
    expect(box.run().exitCode).not.toBe(0)
    expect(existsSync(box.install)).toBe(false)
  }
})

test("missing hash tool, unsafe base and invalid version are refused before writes", () => {
  const box = fixture("Linux", "x86_64", false)
  expect(box.run().stderr.toString()).toContain("sha256sum or shasum is required")
  expect(existsSync(box.install)).toBe(false)
  const normal = fixture()
  for (const env of [{ MENDCODE_VERSION: "1.2.3/../../x" }, { MENDCODE_DOWNLOAD_BASE: "http://example.test/releases" }]) {
    expect(normal.run(env).exitCode).not.toBe(0)
    expect(existsSync(normal.install)).toBe(false)
  }
})

test("cosign verifies both bundles with the exact tag identity and fails closed", () => {
  const box = fixture()
  const log = path.join(box.install, "cosign.log")
  writeFileSync(path.join(box.tools, "cosign"), '#!/bin/sh\nprintf "%s|%s|%s\\n" "$TUF_ROOT" "$XDG_CACHE_HOME" "$*" >> "$COSIGN_LOG"\nexit "$COSIGN_EXIT"\n', { mode: 0o755 })
  for (const file of [box.name, "SHA256SUMS"]) writeFileSync(path.join(box.assets, `${file}.sigstore.json`), "fake bundle")
  expect(box.run({ COSIGN_LOG: log, COSIGN_EXIT: "0" }).exitCode).toBe(0)
  const calls = readFileSync(log, "utf8").trim().split("\n")
  expect(calls).toHaveLength(2)
  for (const call of calls) {
    const [tuf, cache] = call.split("|")
    expect(tuf!.startsWith(path.join(box.install, ".mendcode-install."))).toBe(true)
    expect(cache!.startsWith(path.join(box.install, ".mendcode-install."))).toBe(true)
    expect(existsSync(tuf!)).toBe(false)
    expect(call).toContain("--bundle")
    expect(call).toContain("--certificate-identity https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/v1.2.3")
    expect(call).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com")
  }
  writeFileSync(path.join(box.install, "mendcode"), "previous")
  expect(box.run({ COSIGN_LOG: log, COSIGN_EXIT: "1" }).exitCode).not.toBe(0)
  expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe("previous")
})

const NIGHTLY = "0.0.1-nightly.20261005.12"
const native = (box: ReturnType<typeof fixture>, name: string) => symlinkSync(Bun.which(name)!, path.join(box.tools, name))
const fakeCosign = (box: ReturnType<typeof fixture>, version: string) => {
  writeFileSync(path.join(box.tools, "cosign"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COSIGN_LOG"\nexit "${COSIGN_EXIT:-0}"\n', { mode: 0o755 })
  for (const file of [box.name, "SHA256SUMS"]) writeFileSync(path.join(box.assets, `${file}.sigstore.json`), `bundle of ${file} for ${version}`)
}

test("the nightly tag form installs with the same strict validation and cosign identity as the others", () => {
  const box = fixture("Linux", "x86_64", true, NIGHTLY)
  fakeCosign(box, NIGHTLY)
  const log = path.join(box.dir, "cosign.log")
  const result = box.run({ COSIGN_LOG: log, MENDCODE_ALLOW_UNSIGNED: "0" })
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
  expect(box.name).toBe(`mendcode-${NIGHTLY}-linux-x64`)
  expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe(body)
  expect(result.stdout.toString()).toContain(`Verified SHA256 and the cosign signature of v${NIGHTLY}`)
  const calls = readFileSync(log, "utf8").trim().split("\n")
  expect(calls).toHaveLength(2)
  for (const call of calls) expect(call).toContain(`--certificate-identity https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/v${NIGHTLY}`)
  expect(box.run({ MENDCODE_VERSION: `v${NIGHTLY}`, COSIGN_LOG: log }).exitCode).toBe(0)
})

test("malformed nightly tags are refused before anything is written", () => {
  for (const version of ["0.0.1-nightly.2026100.1", "0.0.1-nightly.202610055.1", "0.0.1-nightly.20261005.0", "0.0.1-nightly.20261005.012", "0.0.1-nightly.20261005", "0.0.1-nightly.20261005.1.2", "0.0.1-nightly", "0.0.1-rc.1", "0.0.1-nightly.20261005.12/../x"]) {
    const box = fixture("Linux", "x86_64", true)
    const result = box.run({ MENDCODE_VERSION: version })
    expect([version, result.exitCode, result.stderr.toString().includes("unsupported release version")]).toEqual([version, 1, true])
    expect(existsSync(box.install)).toBe(false)
  }
})

test("without cosign the install checks the SHA256 and says the signature was not checked; MENDCODE_REQUIRE_SIGNATURE=1 stops before any download", () => {
  const box = fixture()
  const refused = box.run({ MENDCODE_ALLOW_UNSIGNED: "0", MENDCODE_REQUIRE_SIGNATURE: "1" })
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr.toString()).toContain("cosign is required by MENDCODE_REQUIRE_SIGNATURE=1")
  expect(existsSync(box.install)).toBe(false)
  const plain = box.run({ MENDCODE_ALLOW_UNSIGNED: "0" })
  expect(plain.exitCode).toBe(0)
  expect(plain.stdout.toString()).toContain("cosign is not installed, so its signature was not checked")
})

test("a signature that fails is never skipped, even with MENDCODE_ALLOW_UNSIGNED=1; a missing bundle fails closed too", () => {
  const box = fixture("Linux", "x86_64", true, NIGHTLY)
  fakeCosign(box, NIGHTLY)
  const log = path.join(box.dir, "cosign.log")
  expect(box.run({ COSIGN_LOG: log, COSIGN_EXIT: "1" }).stderr.toString()).toContain("invalid cosign signature")
  expect(existsSync(path.join(box.install, "mendcode"))).toBe(false)
  rmSync(path.join(box.assets, `${box.name}.sigstore.json`))
  const missing = box.run({ COSIGN_LOG: log })
  expect(missing.exitCode).toBe(1)
  expect(missing.stderr.toString()).toContain(`no signature bundle ${box.name}.sigstore.json`)
  expect(existsSync(path.join(box.install, "mendcode"))).toBe(false)
})

const LISTING = [
  ["v0.0.0", "false"], ["v0.0.1-beta.2", "true"], ["v0.0.1-beta.10", "true"], ["v0.0.1-nightly.20261004.30", "true"],
  ["v0.0.1-nightly.20261005.9", "true"], ["v0.0.1-nightly.20261005.12", "true"], ["v0.0.1-nightly.20261006.1", "false"], ["v0.0.0-nightly.20261230.1", "true"], ["nightly", "true"],
] as const

test("the channel picks the newest release through an authenticated gh, which is how a private repository is read", () => {
  const box = fixture("Linux", "x86_64", true, NIGHTLY)
  fakeCosign(box, NIGHTLY)
  native(box, "cp")
  const log = path.join(box.dir, "gh.log")
  writeFileSync(path.join(box.tools, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "auth status") exit 0 ;;
  "release list") printf '%s\\n' "$GH_LIST"; exit 0 ;;
  "release download") tag=$3; shift 3; pattern=; dir=
    while [ $# -gt 0 ]; do case $1 in --pattern) pattern=$2; shift 2 ;; --dir) dir=$2; shift 2 ;; *) shift ;; esac; done
    cp "$GH_ASSETS/$tag/$pattern" "$dir/$pattern" ;;
esac
`, { mode: 0o755 })
  const env = { GH_LOG: log, GH_LIST: LISTING.map(([tag, pre]) => `${tag}\t${pre}`).join("\n"), GH_ASSETS: path.join(box.dir, "release", "download"), COSIGN_LOG: path.join(box.dir, "cosign.log"), MENDCODE_DOWNLOAD_BASE: "", MENDCODE_VERSION: "" }
  for (const [args, extra] of [[["--channel", "nightly"], {}], [["--channel=nightly"], {}], [[], { MENDCODE_CHANNEL: "nightly" }]] as const) {
    rmSync(path.join(box.install), { recursive: true, force: true })
    const result = box.run({ ...env, ...extra }, [...args])
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
    expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe(body)
  }
  const calls = readFileSync(log, "utf8")
  expect(calls).toContain("release list --repo MendCode/MendCode --limit 100 --json tagName,isPrerelease,isDraft")
  expect(calls).toContain(`release download v${NIGHTLY} --repo MendCode/MendCode --pattern SHA256SUMS --dir`)
  expect(calls).not.toContain("v0.0.1-nightly.20261006.1")
  for (const [channel, expected] of [["stable", "v0.0.0"], ["beta", "v0.0.1-beta.10"]] as const) {
    writeFileSync(log, "")
    box.run({ ...env, MENDCODE_CHANNEL: channel })
    expect(readFileSync(log, "utf8")).toContain(`release download ${expected} --repo MendCode/MendCode`)
  }
  // A channel takes every steadier channel's releases: a newer stable wins over betas and nightlies, and a repository with only
  // a stable release installs it on every channel instead of failing with "no beta release found".
  for (const [list, channel, expected] of [
    [[...LISTING, ["v0.0.1", "false"]], "beta", "v0.0.1"], [[...LISTING, ["v0.0.1", "false"]], "nightly", "v0.0.1"],
    [[["v0.0.1", "false"]], "beta", "v0.0.1"], [[["v0.0.1", "false"]], "nightly", "v0.0.1"],
  ] as const) {
    writeFileSync(log, "")
    box.run({ ...env, GH_LIST: list.map(([tag, pre]) => `${tag}\t${pre}`).join("\n"), MENDCODE_CHANNEL: channel })
    expect(readFileSync(log, "utf8")).toContain(`release download ${expected} --repo MendCode/MendCode`)
  }
})

test("without gh the channel is read from the public API with the same ordering, and mislabelled releases are ignored", async () => {
  const box = fixture("Linux", "x86_64", true, NIGHTLY)
  fakeCosign(box, NIGHTLY)
  const pretty = JSON.stringify(LISTING.map(([tag, pre]) => ({ url: `https://api.github.com/repos/x/y/releases/${tag}`, tag_name: tag, name: tag, draft: false, prerelease: pre === "true", assets: [{ name: "a", tag_name_like: "x" }] })), null, 2)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/releases" ? new Response(pretty) : new Response("unexpected", { status: 404 }) })
  try {
    const running = Bun.spawn(["/bin/sh", script, "--channel", "nightly"], {
      env: { HOME: path.join(box.dir, "home"), PATH: box.tools, FAKE_OS: "Linux", FAKE_ARCH: "x86_64", MENDCODE_INSTALL_DIR: box.install, MENDCODE_DOWNLOAD_BASE: pathToFileURL(path.join(box.dir, "release")).href, MENDCODE_API_BASE: `http://127.0.0.1:${server.port}`, MENDCODE_ALLOW_UNSIGNED: "0", COSIGN_LOG: path.join(box.dir, "cosign.log") },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stderr, stdout] = await Promise.all([running.exited, new Response(running.stderr).text(), new Response(running.stdout).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain(`Installed mendcode ${NIGHTLY}`)
  } finally { server.stop(true) }
})

test("an unknown channel, a channel with an exact version and a stray argument are refused", () => {
  const box = fixture()
  for (const [extra, args, message] of [[{ MENDCODE_VERSION: "" }, ["--channel", "edge"], "channel must be"], [{}, ["--channel", "nightly"], "cannot be combined"], [{ MENDCODE_VERSION: "" }, ["--wat"], "unknown argument"], [{ MENDCODE_VERSION: "" }, ["--channel"], "needs a value"]] as const) {
    const result = box.run({ ...extra }, [...args])
    expect([result.exitCode, result.stderr.toString().includes(message)]).toEqual([1, true])
    expect(existsSync(box.install)).toBe(false)
  }
})

test("--tier, --tier= and MENDCODE_TIER record the starting tier in the receipt, balanced when none is given, and the binary is the same", () => {
  const box = fixture()
  const receipt = () => readFileSync(path.join(box.install, ".mendcode-v2-install"), "utf8")
  for (const [args, extra, tier] of [[["--tier", "minimalist"], {}, "minimalist"], [["--tier=full"], {}, "full"], [[], { MENDCODE_TIER: "minimalist" }, "minimalist"], [["--tier", "balanced"], { MENDCODE_TIER: "full" }, "balanced"], [[], {}, "balanced"]] as const) {
    rmSync(box.install, { recursive: true, force: true })
    const result = box.run({ ...extra }, [...args])
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
    expect(receipt()).toBe(`schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${hash}\ntier=${tier}\n`)
    expect(result.stdout.toString()).toContain(`starting tier: ${tier}`)
    expect(readFileSync(path.join(box.install, "mendcode"), "utf8")).toBe(body)
  }
})

test("--tier composes with --channel and an unknown or valueless tier is refused before anything is written", () => {
  const box = fixture()
  expect(box.run({ MENDCODE_VERSION: "" }, ["--channel", "nightly", "--tier", "bogus"]).stderr.toString()).toContain("tier must be minimalist, balanced or full")
  for (const [args, message] of [[["--tier", "Full"], "tier must be"], [["--tier"], "needs a value"]] as const) {
    const result = box.run({ MENDCODE_VERSION: "" }, [...args])
    expect([result.exitCode, result.stderr.toString().includes(message)]).toEqual([1, true])
    expect(existsSync(box.install)).toBe(false)
  }
  expect(box.run({}, ["--help"]).stdout.toString()).toContain("--tier minimalist|balanced|full")
})

const pwsh = Bun.which("pwsh")
test.skipIf(!pwsh)("PowerShell installer parses without executing it", () => {
  const result = Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-Command", '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALL_SCRIPT, [ref]$tokens, [ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }'], {
    env: { ...process.env, INSTALL_SCRIPT: path.join(import.meta.dir, "install.ps1") }, stdout: "pipe", stderr: "pipe",
  })
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" })
})
