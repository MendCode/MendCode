import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { parseMendPackageManifest, readMendPackageManifest } from "../../src/mend/runtime/registry/package-manifest"
import { MEND_PUBLIC_TUI_SLOTS, isMendPublicSlotName, validateMendSlotRegistration } from "../../src/mend/sdk/slots"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("mend package manifest", () => {
  test("parses a valid manifest", () => {
    const manifest = parseMendPackageManifest({
      version: 0,
      id: "starter-js",
      packageVersion: "1.0.1",
      title: "Starter JS",
      description: "JavaScript starter package",
      compatibility: {
        mendcode: "^0.2.0",
        runtimePack: "^0",
      },
      artifacts: {
        commands: [".mendcode/commands"],
        modes: [".mendcode/modes/build.md"],
        plugins: [".mendcode/plugins/status.ts"],
        prompts: [".mendcode/prompts"],
        extensions: [".mendcode/widgets/panel.ts"],
        tuiProfile: ".mendcode/tui/profile.json",
      },
      distribution: {
        source: {
          type: "github",
          url: "https://example.com/repo.git",
        },
        trust: {
          signatureRequired: true,
        },
      },
    })

    expect(manifest.id).toBe("starter-js")
    expect(manifest.packageVersion).toBe("1.0.1")
    expect(manifest.artifacts?.commands).toEqual([".mendcode/commands"])
    expect(manifest.artifacts?.modes).toEqual([".mendcode/modes/build.md"])
    expect(manifest.artifacts?.plugins).toEqual([".mendcode/plugins/status.ts"])
    expect(manifest.artifacts?.extensions).toEqual([".mendcode/widgets/panel.ts"])
    expect(manifest.artifacts?.tuiProfile).toBe(".mendcode/tui/profile.json")
    expect(manifest.distribution?.trust?.signatureRequired).toBe(true)
  })

  test("rejects unsupported version", () => {
    expect(() => parseMendPackageManifest({ version: 1, id: "bad-pack" })).toThrow("unsupported")
  })

  test("reads root manifest before .mendcode/package.json fallback", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, "mend-package.json"), {
      version: 0,
      id: "root-pack",
      title: "Root Pack",
    })
    await writeJson(path.join(dir.path, ".mendcode", "package.json"), {
      version: 0,
      id: "nested-pack",
      title: "Nested Pack",
    })

    const result = await readMendPackageManifest(dir.path)
    expect(result?.path).toBe("mend-package.json")
    expect(result?.manifest.id).toBe("root-pack")
  })
})

describe("mend sdk slot helpers", () => {
  test("recognizes public slot names", () => {
    expect(MEND_PUBLIC_TUI_SLOTS).toContain("home_logo")
    expect(isMendPublicSlotName("sidebar_footer")).toBe(true)
    expect(isMendPublicSlotName("custom.experimental.slot")).toBe(false)
  })

  test("validates slot registration shape", () => {
    const result = validateMendSlotRegistration({
      slots: {
        home_logo() {
          return null
        },
        "custom.experimental.slot"() {
          return null
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.publicNames).toEqual(["home_logo"])
    expect(result.customNames).toEqual(["custom.experimental.slot"])
  })
})
