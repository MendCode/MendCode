import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { loadMendTuiProfile, mergeMendTuiProfile, validateMendTuiProfile } from "./profile"
import { activityMascotHoverText, activityMascotText, homeMascotText } from "./tui/mascot"
import { resolvePromptStatus } from "./tui/prompt-status"

const previousTuiProfilePath = process.env.MENDCODE_TUI_PROFILE_PATH
const isolatedTuiProfileRoot = mkdtempSync(path.join(os.tmpdir(), "mend-global-tui-profile-"))

beforeAll(() => {
  process.env.MENDCODE_TUI_PROFILE_PATH = path.join(isolatedTuiProfileRoot, "profile.json")
})

afterAll(() => {
  if (previousTuiProfilePath === undefined) delete process.env.MENDCODE_TUI_PROFILE_PATH
  else process.env.MENDCODE_TUI_PROFILE_PATH = previousTuiProfilePath
  rmSync(isolatedTuiProfileRoot, { recursive: true, force: true })
})

describe("Mend TUI profile config overrides", () => {
  test("promptStatus.commandsHint.visible=false removes commandsHint without rewriting status arrays", () => {
    const status = resolvePromptStatus(
      {
        enabled: true,
        commandsHint: { visible: false },
        left: [{ type: "builtin", value: "commandsHint" }],
        right: [
          { type: "builtin", value: "context" },
          { type: "builtin", value: "commandsHint" },
        ],
      },
      "left-rail",
    )

    expect(status.left).toEqual([])
    expect(status.right).toEqual([{ type: "builtin", value: "context" }])
  })

  test("home.logo.path loads custom home ASCII from config", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mend-tui-profile-"))
    const logoPath = path.join(root, "pet.txt")
    writeFileSync(logoPath, " /\\_/\\\\\n( o.o )\n > ^ <\n")

    try {
      const result = await loadMendTuiProfile(root, {
        home: {
          logo: {
            path: logoPath,
          },
        },
      })

      expect(result.profile.surfaces.homeLogo?.text).toBe(" /\\_/\\\\\n( o.o )\n > ^ <")
      expect(result.profile.identity.logoMode).toBe("mascot")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("identity can be overridden from TUI config", async () => {
    const result = await loadMendTuiProfile(undefined, {
      identity: {
        productName: "PetCode",
        logoMode: "mascot",
        logoFont: "shadow",
      },
    })

    expect(result.profile.identity.productName).toBe("PetCode")
    expect(result.profile.identity.logoMode).toBe("mascot")
    expect(result.profile.identity.logoFont).toBe("shadow")
    expect(homeMascotText(result.profile)).toContain("[+]")
    expect(homeMascotText(result.profile).split("\n")[0]).toBe("      .-.")
    expect(activityMascotText(result.profile, "thinking")).toContain("(o -)")
    expect(activityMascotText(result.profile, "memory")).toContain("(o m)")
    expect(activityMascotText(result.profile, "thinking")).not.toContain("thinking")
    expect(activityMascotText(result.profile, "idle")?.split("\n")[0]).toBe("  .-.")
    expect(activityMascotHoverText(result.profile)).toContain("(^ ^)")
  })

  test("legacy opencode logo font is accepted as MendCode font", async () => {
    const result = await loadMendTuiProfile(undefined, {
      identity: {
        logoFont: "opencode",
      },
    })

    expect(result.profile.identity.logoFont).toBe("mendcode")
  })

  test("project roots without local profile inherit custom prompt status scripts", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mend-tui-no-profile-"))
    const globalProfilePath = process.env.MENDCODE_TUI_PROFILE_PATH!
    mkdirSync(path.dirname(globalProfilePath), { recursive: true })
    writeFileSync(
      globalProfilePath,
      JSON.stringify({
        version: 0,
        promptStatus: {
          commandsHint: { visible: false },
          scripts: {
            left: {
              enabled: true,
              command: "./.mendcode/tui/seda-statusline-9.sh --left",
            },
          },
        },
      }),
    )

    try {
      const result = await loadMendTuiProfile(root)

      expect(result.root).toBe(root)
      expect(result.activePath).toBe(globalProfilePath)
      expect(result.profile.promptStatus.commandsHint?.visible).toBe(false)
      expect(result.profile.promptStatus.scripts?.left?.enabled).toBe(true)
      expect(result.profile.promptStatus.scripts?.left?.command).toContain("/.mendcode/tui/seda-statusline-9.sh'")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(globalProfilePath, { force: true })
    }
  })

  test("active chat presentation wins over config defaults on reload", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mend-tui-profile-"))
    const profilePath = path.join(root, ".mendcode", "tui", "profile.json")
    mkdirSync(path.dirname(profilePath), { recursive: true })
    writeFileSync(
      profilePath,
      JSON.stringify({
        version: 0,
        profile: "default",
        presentation: {
          profile: "raw",
        },
      }),
    )

    try {
      const result = await loadMendTuiProfile(root, {
        presentation: {
          profile: "mendcode",
        },
      })

      expect(result.profile.presentation.profile).toBe("raw")
      expect(result.profile.presentation.reasoning.defaultVisibility).toBe("visible")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("home logo size and welcome mode can be overridden from TUI config", async () => {
    const result = await loadMendTuiProfile(undefined, {
      home: {
        logo: {
          mode: "mascot",
          size: "large",
        },
        welcome: {
          mode: "split",
          rightPanel: "agentManager",
        },
      },
      presentation: {
        activity: {
          mascot: {
            hover: "  .-.\n (^ o)\n /[+]\\",
            states: {
              idle: "  .-.\n (- o)   idle\n /[+]\\",
            },
          },
        },
      },
    })

    expect(result.profile.identity.logoMode).toBe("mascot")
    expect(result.profile.surfaces.homeLogo?.size).toBe("large")
    expect(result.profile.surfaces.homeWelcome?.mode).toBe("split")
    expect(result.profile.surfaces.homeWelcome?.rightPanel).toBe("agentManager")
    expect(homeMascotText(result.profile)).toContain(".-(o o)-.")
    expect(activityMascotText(result.profile, "idle")).not.toContain("idle")
    expect(activityMascotHoverText(result.profile)).toContain("(^ o)")
  })

  test("home welcome right panel defaults to Agent View and validates allowed values", async () => {
    const result = await loadMendTuiProfile(undefined, {
      home: {
        welcome: {
          mode: "split",
        },
      },
    })

    expect(result.profile.surfaces.homeWelcome?.rightPanel).toBe("agentManager")
    expect(validateMendTuiProfile(result.profile).ok).toBe(true)

    const actions = await loadMendTuiProfile(undefined, {
      home: {
        welcome: {
          rightPanel: "actions",
        },
      },
    })

    expect(actions.profile.surfaces.homeWelcome?.rightPanel).toBe("actions")

    const invalid = mergeMendTuiProfile({
      ...result.profile,
      surfaces: {
        ...result.profile.surfaces,
        homeWelcome: {
          ...result.profile.surfaces.homeWelcome,
          rightPanel: "sessions",
        },
      },
    })

    expect(validateMendTuiProfile(invalid).failures).toContain("tui surfaces.homeWelcome.rightPanel is invalid")
  })
})
