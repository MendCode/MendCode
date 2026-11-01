import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { release, tmpdir } from "node:os"
import path from "node:path"

// Which speech models the dictation helper listens with: `--resolve` compiles the real helper and runs only that choice (no
// microphone, no speech model). The supported list is what macOS 26 offered for English and Spanish.
const canCompile = process.platform === "darwin" && Number(release().split(".")[0]) >= 25 && existsSync("/usr/bin/xcrun")
const SUPPORTED = "en_AU,en_CA,en_GB,en_IE,en_IN,en_NZ,en_SG,en_US,en_ZA,es_CL,es_ES,es_MX,es_US"
let dir = "", helper = ""

beforeAll(async () => {
  if (!canCompile) return
  dir = mkdtempSync(path.join(tmpdir(), "mc-dictate-"))
  helper = path.join(dir, "mendcode-dictate")
  const compiled = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", "-parse-as-library", path.join(import.meta.dir, "../assets/dictate.swift"), "-o", helper], { stderr: "pipe" })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
}, 180_000)
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function resolve(wanted: string, preferred: string, supported = SUPPORTED): string[] {
  const run = Bun.spawnSync([helper, "--resolve", wanted, preferred, supported], { stdout: "pipe", stderr: "pipe" })
  expect(run.exitCode).toBe(0)
  return JSON.parse(run.stdout.toString()).locales
}

test.skipIf(!canCompile)("auto on a Mac set to English (Panama) with Spanish second hears US English and Spanish, not Irish English", () => {
  expect(resolve("auto", "en-PA,es-PA")).toEqual(["en_US", "es_ES"])
})

test.skipIf(!canCompile)("auto keeps a preferred region the models have and takes at most two languages", () => {
  expect(resolve("auto", "en-GB,en-US,es-MX,fr-FR")).toEqual(["en_GB", "es_MX"])
})

test.skipIf(!canCompile)("a named language listens with that language alone", () => {
  expect(resolve("es", "en-PA,es-PA")).toEqual(["es_ES"])
  expect(resolve("en-US", "es-PA")).toEqual(["en_US"])
})

test.skipIf(!canCompile)("two named languages listen together, whatever the Mac prefers", () => {
  expect(resolve("es,en", "fr-FR")).toEqual(["es_ES", "en_US"])
  expect(resolve("es,es", "en-PA")).toEqual(["es_ES"])
})

function live(locales: string, ...texts: string[]): string {
  const run = Bun.spawnSync([helper, "--live", locales, ...texts], { stdout: "pipe", stderr: "pipe" })
  expect(run.exitCode).toBe(0)
  return JSON.parse(run.stdout.toString()).locale
}

// The running transcripts below are what macOS 26's English and Spanish models wrote while hearing the same synthetic speech.
test.skipIf(!canCompile)("while listening, Spanish speech shows the Spanish model's words, not the English model's spelling of their sounds", () => {
  expect(live("en_US,es_ES", "quivo de configulacóas porque la", "Quiero que revises el archivo de configuración")).toBe("es_ES")
  expect(live("en_US,es_ES", "o de config", "Quiero que revises el archivo")).toBe("es_ES")
})

test.skipIf(!canCompile)("while listening, English speech shows the English model's words", () => {
  expect(live("en_US,es_ES", "Please open the settings file and", "Please open the settings s file and")).toBe("en_US")
  expect(live("es_ES,en_US", "Please open the settings s file and", "Please open the settings file and")).toBe("en_US")
})

test.skipIf(!canCompile)("before any words, the row keeps the first language instead of guessing", () => {
  expect(live("en_US,es_ES", "", "")).toBe("en_US")
})

test.skipIf(!canCompile)("a language without an on-device model resolves to nothing, so the helper reports it instead of guessing", () => {
  expect(resolve("auto", "fr-FR")).toEqual([])
  expect(resolve("auto", "fr-FR,es-PA")).toEqual(["es_ES"])
})
