import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Command } from "../../src/command"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("command", () => {
  it.live("does not expose skills as slash commands", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mendcode", "skill", "tool-skill", "SKILL.md"),
              `---
name: tool-skill
description: Skill for command registry tests.
---

# Tool Skill
`,
            ),
          )

          const command = yield* Command.Service
          const commands = yield* command.list()

          expect(commands.some((item) => item.name === "tool-skill")).toBe(false)
          expect(commands.some((item) => item.source === "skill")).toBe(false)
        }),
      { git: true },
    ),
  )
})
