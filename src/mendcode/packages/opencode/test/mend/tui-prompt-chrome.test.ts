import { describe, expect, test } from "bun:test"
import { defaultTuiProfile, mergeMendTuiProfile, validateMendTuiProfile } from "../../src/mend/profile"
import { promptChromeUsesFullSessionWidth, resolvePromptChrome } from "../../src/mend/tui/prompt-chrome"
import {
  pickPromptStatusScriptOutput,
  promptStatusScriptIdentityKey,
  resolvePromptStatus,
} from "../../src/mend/tui/prompt-status"
import { resolveActivityPhase } from "../../src/cli/cmd/tui/util/activity-signal"
import { activityMessagesForPhase, resolveTuiPresentation, shouldDisplayReasoning } from "../../src/mend/tui/presentation"
import { ConfigKeybinds } from "../../src/config/keybinds"

describe("mend tui prompt chrome", () => {
  test("default profile keeps top-bottom prompt chrome", () => {
    expect(defaultTuiProfile().promptChrome.preset).toBe("top-bottom")
    expect(defaultTuiProfile().promptStatus.placementByPreset?.["ascii-box"]).toBe("inside")
    expect(defaultTuiProfile().promptStatus.commandsHint?.visible).toBe(false)
    expect(defaultTuiProfile().promptStatus.right).toEqual([])
    expect(defaultTuiProfile().workingIndicator.messages).toEqual(["Thinking..."])
    expect(defaultTuiProfile().workingIndicator.showTokenUsage).toBe(true)
    expect(defaultTuiProfile().presentation.profile).toBe("mendcode")
    expect(defaultTuiProfile().presentation.activity.maxLines).toBe(1)
    expect(defaultTuiProfile().layout.zones.session.stickyUserHeader).toBe(true)
    expect(defaultTuiProfile().layout.zones.session.submitScrollMode).toBe("bottom")
    expect(validateMendTuiProfile(defaultTuiProfile()).ok).toBe(true)
  })

  test("context meter is opt-in even when old profiles still list the context builtin", () => {
    const profile = mergeMendTuiProfile({
      promptStatus: {
        right: [{ type: "builtin", value: "context" }],
      },
    })
    const resolved = resolvePromptStatus(profile.promptStatus, "top-bottom")

    expect(resolved.context?.visible).toBe(false)
    expect(resolved.right).toEqual([{ type: "builtin", value: "context" }])

    const visible = mergeMendTuiProfile({
      promptStatus: {
        context: { visible: true },
        right: [{ type: "builtin", value: "context" }],
      },
    })

    expect(resolvePromptStatus(visible.promptStatus, "top-bottom").context?.visible).toBe(true)
  })

  test("sticky user header remains configurable through session layout", () => {
    const profile = mergeMendTuiProfile({
      layout: {
        zones: {
          session: {
            stickyUserHeader: true,
          },
        },
      },
    })

    expect(profile.layout.zones.session.stickyUserHeader).toBe(true)
    expect(validateMendTuiProfile(profile).ok).toBe(true)

    const disabled = mergeMendTuiProfile({
      layout: {
        zones: {
          session: {
            stickyUserHeader: false,
          },
        },
      },
    })

    expect(disabled.layout.zones.session.stickyUserHeader).toBe(false)
    expect(validateMendTuiProfile(disabled).ok).toBe(true)
  })

  test("submit scroll behavior remains configurable through session layout", () => {
    const clear = mergeMendTuiProfile({
      layout: {
        zones: {
          session: {
            submitScrollMode: "clear",
          },
        },
      },
    })

    expect(clear.layout.zones.session.submitScrollMode).toBe("clear")
    expect(validateMendTuiProfile(clear).ok).toBe(true)

    const invalid = mergeMendTuiProfile({
      layout: {
        zones: {
          session: {
            submitScrollMode: "middle",
          },
        },
      },
    })

    expect(validateMendTuiProfile(invalid).failures).toContain(
      "tui layout.zones.session.submitScrollMode is invalid",
    )
  })

  test("merge preserves prompt chrome overrides", () => {
    const profile = mergeMendTuiProfile({
      promptChrome: {
        preset: "ascii-box",
        borderStyle: "ascii",
        glyphs: { horizontal: "=", leadText: "::" },
      },
    })
    expect(profile.promptChrome.preset).toBe("ascii-box")
    expect(profile.promptChrome.borderStyle).toBe("ascii")
    expect(profile.promptChrome.glyphs?.horizontal).toBe("=")
    expect(profile.promptChrome.glyphs?.leadText).toBe("::")
    expect(profile.promptStatus.left.length).toBeGreaterThan(0)
  })

  test("merge preserves thinking status text and script refresh interval overrides", () => {
    const profile = mergeMendTuiProfile({
      promptStatus: {
        scripts: {
          left: {
            enabled: true,
            command: "date +%S",
            refreshMs: 2000,
          },
        },
      },
      workingIndicator: {
        messages: ["Thinking...", "Checking tests..."],
        messageIntervalMs: 1200,
        showTokenUsage: false,
      },
    })
    const resolved = resolvePromptStatus(profile.promptStatus, "left-rail")

    expect(resolved.scripts.left?.refreshMs).toBe(2000)
    expect(profile.workingIndicator.messages).toEqual(["Thinking...", "Checking tests..."])
    expect(profile.workingIndicator.messageIntervalMs).toBe(1200)
    expect(profile.workingIndicator.showTokenUsage).toBe(false)
    expect(validateMendTuiProfile(profile).ok).toBe(true)
  })

  test("presentation profile resolves raw minimal and mendcode defaults", () => {
    expect(resolveTuiPresentation({ profile: "raw" }).activity.style).toBe("raw")
    expect(resolveTuiPresentation({ profile: "minimal" }).activity.maxLines).toBe(1)
    expect(resolveTuiPresentation({ profile: "mendcode" }).reasoning.defaultVisibility).toBe("collapsed")
  })

  test("raw and full presentations can show reasoning before completion", () => {
    const raw = mergeMendTuiProfile({
      presentation: {
        profile: "raw",
      },
    })
    const mendcode = mergeMendTuiProfile({
      presentation: {
        profile: "mendcode",
        reasoning: {
          defaultVisibility: "visible",
        },
      },
    })

    expect(shouldDisplayReasoning(raw, { completed: false, showThinking: false })).toBe(true)
    expect(
      shouldDisplayReasoning(
        mergeMendTuiProfile({
          presentation: {
            profile: "raw",
            reasoning: {
              defaultVisibility: "collapsed",
            },
          },
        }),
        { completed: false, showThinking: false },
      ),
    ).toBe(true)
    expect(shouldDisplayReasoning(mendcode, { completed: false, showThinking: true })).toBe(true)
    expect(shouldDisplayReasoning(mendcode, { completed: false, showThinking: false })).toBe(true)
    expect(shouldDisplayReasoning(mendcode, { completed: true, showThinking: false })).toBe(true)
    expect(shouldDisplayReasoning(mendcode, { completed: true, showThinking: true })).toBe(true)
    expect(
      shouldDisplayReasoning(
        mergeMendTuiProfile({
          presentation: {
            profile: "mendcode",
            reasoning: {
              defaultVisibility: "hidden",
            },
          },
        }),
        { completed: true, showThinking: true },
      ),
    ).toBe(false)
  })

  test("presentation profile changes preserve configured activity text", () => {
    const current = resolveTuiPresentation({
      profile: "mendcode",
      activity: {
        messages: {
          testing: ["Checking locally..."],
        },
      },
      symbols: {
        assistantDone: "◆",
      },
    })

    const next = resolveTuiPresentation({ ...current, profile: "minimal" })

    expect(next.profile).toBe("minimal")
    expect(next.activity.messages.testing).toEqual(["Checking locally..."])
    expect(next.symbols.assistantDone).toBe("◆")
  })

  test("presentation phase messages override working indicator fallback", () => {
    const profile = mergeMendTuiProfile({
      workingIndicator: {
        messages: ["Working..."],
      },
      presentation: {
        profile: "mendcode",
        activity: {
          messages: {
            testing: ["Testing...", "Checking behavior..."],
          },
        },
      },
    })

    expect(activityMessagesForPhase(profile, "testing")).toEqual(["Testing..."])
    expect(activityMessagesForPhase(profile, "memory")).toEqual(["Preparing memory..."])
    expect(activityMessagesForPhase(profile, "blocked")).toEqual(["Waiting..."])
    expect(validateMendTuiProfile(profile).ok).toBe(true)
  })

  test("presentation phase messages resolve to one text per activity status", () => {
    const profile = mergeMendTuiProfile({
      workingIndicator: {
        messages: ["Working...", "Still working..."],
      },
      presentation: {
        profile: "mendcode",
        activity: {
          messages: {
            patching: ["Patching...", "Writing diff..."],
          },
        },
      },
    })

    expect(activityMessagesForPhase(profile, "patching")).toEqual(["Patching..."])
    expect(activityMessagesForPhase(profile, "uploading")).toEqual(["Uploading..."])
    expect(validateMendTuiProfile(profile).ok).toBe(true)
  })

  test("activity signal resolves additional status events", () => {
    expect(resolveActivityPhase({ status: "busy", toolNames: ["bash"] })).toBe("running")
    expect(resolveActivityPhase({ status: "busy", toolNames: ["webfetch"] })).toBe("browsing")
    expect(resolveActivityPhase({ status: "busy", toolNames: ["upload_artifact"] })).toBe("uploading")
    expect(resolveActivityPhase({ status: "busy", toolNames: ["download_file"] })).toBe("downloading")
    expect(resolveActivityPhase({ status: "busy", toolNames: ["pnpm_install"] })).toBe("installing")
    expect(resolveActivityPhase({ status: "busy", statusKind: "memory-extract" })).toBe("memory")
  })

  test("resolves presets into prompt border sides", () => {
    expect(resolvePromptChrome({ preset: "left-rail" }).preset).toBe("top-bottom")
    expect(resolvePromptChrome({ preset: "box" }).mainSides).toEqual(["top", "left", "right", "bottom"])
    expect(resolvePromptChrome({ preset: "box" }).footerSides).toEqual([])
    expect(resolvePromptChrome({ preset: "box" }).leadText).toBe("❭")
    expect(resolvePromptChrome({ preset: "top-bottom" }).mainSides).toEqual(["top", "bottom"])
    expect(resolvePromptChrome({ preset: "top-bottom" }).footerSides).toEqual([])
    expect(resolvePromptChrome({ preset: "top-bottom" }).leadText).toBe("❭")
    expect(resolvePromptChrome({ preset: "minimal" }).mainSides).toEqual([])
    expect(resolvePromptChrome({ preset: "ascii-box" }).leadText).toBe("❭")
    expect(resolvePromptChrome({ preset: "ascii-box" }).chars.topLeft).toBe("+")
    expect(resolvePromptStatus(undefined, "ascii-box").placement).toBe("inside")
    expect(resolvePromptStatus(undefined, "minimal").placement).toBe("outside")
  })

  test("all built-in prompt chrome presets use the full session width", () => {
    expect(promptChromeUsesFullSessionWidth("box")).toBe(true)
    expect(promptChromeUsesFullSessionWidth("top-bottom")).toBe(true)
    expect(promptChromeUsesFullSessionWidth("minimal")).toBe(true)
    expect(promptChromeUsesFullSessionWidth("ascii-box")).toBe(true)
  })

  test("ctrl-t is reserved for session todos and f3 cycles model variants", () => {
    const keybinds = ConfigKeybinds.Keybinds.parse({})

    expect(keybinds.todo_toggle).toBe("ctrl+t")
    expect(keybinds.variant_cycle).toBe("f3")
    expect(keybinds.variant_list).toBe("shift+f3")
  })

  test("prompt status supports per-side scripts and preserves legacy left script fallback", () => {
    const resolved = resolvePromptStatus(
      {
        enabled: true,
        left: [{ type: "builtin", value: "mode" }],
        right: [{ type: "builtin", value: "context" }],
        scripts: {
          right: {
            enabled: true,
            command: "./right.sh",
            prepend: true,
          },
        },
        script: {
          enabled: true,
          command: "./legacy-left.sh",
          prepend: false,
        },
      },
      "box",
    )

    expect(resolved.scripts.left?.command).toBe("./legacy-left.sh")
    expect(resolved.scripts.right?.command).toBe("./right.sh")
    expect(resolved.scripts.right?.prepend).toBe(true)
  })

  test("prompt status script identity changes when the selected model changes", () => {
    const base = {
      command: "./status.sh",
      root: "/repo",
      sessionID: "ses_123",
      promptMode: "build",
      model: "GPT-5.5 Fast",
      modelLabel: "GPT-5.5 Fast",
      provider: "OpenAI",
      providerLabel: "OpenAI",
      reasoning: "medium",
      reasoningLabel: "medium",
      preset: "top-bottom" as const,
      side: "left" as const,
      prepend: false,
      timeoutMs: 150,
    }

    expect(
      promptStatusScriptIdentityKey({
        ...base,
        model: "GPT-5.4",
        modelLabel: "GPT-5.4",
      }),
    ).not.toBe(promptStatusScriptIdentityKey(base))
  })

  test("prompt status script identity ignores volatile usage refresh fields", () => {
    const stable = promptStatusScriptIdentityKey({
      command: "./status.sh",
      root: "/repo",
      sessionID: "ses_123",
      promptMode: "build",
      model: "GPT-5.5 Fast",
      modelLabel: "GPT-5.5 Fast",
      provider: "OpenAI",
      providerLabel: "OpenAI",
      reasoning: "medium",
      reasoningLabel: "medium",
      context: "21.5K 21%",
      contextTokens: 21500,
      contextLimit: 100000,
      contextPercent: 21,
      preset: "top-bottom",
      side: "left",
      prepend: false,
      timeoutMs: 150,
      refreshKey: 10,
    })

    expect(
      promptStatusScriptIdentityKey({
        command: "./status.sh",
        root: "/repo",
        sessionID: "ses_123",
        promptMode: "build",
        model: "GPT-5.5 Fast",
        modelLabel: "GPT-5.5 Fast",
        provider: "OpenAI",
        providerLabel: "OpenAI",
        reasoning: "medium",
        reasoningLabel: "medium",
        context: "24.1K 24%",
        contextTokens: 24100,
        contextLimit: 100000,
        contextPercent: 24,
        preset: "top-bottom",
        side: "left",
        prepend: false,
        timeoutMs: 150,
        refreshKey: 11,
      }),
    ).toBe(stable)
  })

  test("prompt status output refuses stale latest text after a model switch", () => {
    expect(
      pickPromptStatusScriptOutput({
        currentIdentity: "model:gpt-5.4",
        latest: {
          identity: "model:gpt-5.5-fast",
          output: { text: "GPT-5.5 Fast" },
        },
      }),
    ).toBeUndefined()

    expect(
      pickPromptStatusScriptOutput({
        currentIdentity: "model:gpt-5.4",
        current: {
          identity: "model:gpt-5.4",
          output: { text: "GPT-5.4" },
        },
        latest: {
          identity: "model:gpt-5.5-fast",
          output: { text: "GPT-5.5 Fast" },
        },
      }),
    ).toEqual({ text: "GPT-5.4" })
  })
})
