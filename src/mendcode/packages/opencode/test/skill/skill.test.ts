import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { FileWatcher } from "../../src/file/watcher"
import { Discovery } from "../../src/skill/discovery"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Global } from "@mendcode/core/global"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { provideInstance, provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Session } from "../../src/session/session"
import path from "path"
import fs from "fs/promises"

const node = CrossSpawnSpawner.defaultLayer
const skillLayer = Skill.layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provideMerge(Bus.layer),
)

const it = testEffect(Layer.mergeAll(skillLayer, node))

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from the legacy global skills directory for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

async function writeSkill(skillPath: string, input: { name: string; description: string; heading?: string }) {
  await Bun.write(
    skillPath,
    `---
name: ${input.name}
description: ${input.description}
---

# ${input.heading ?? input.name}
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = prev
      }),
  )

const waitForSkill = <A>(read: Effect.Effect<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt++) {
      const value = yield* read
      if (predicate(value)) return value
      yield* Effect.sleep("50 millis")
    }
    return yield* read
  })

describe("skill", () => {
  it.live("discovers skills from .mendcode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mendcode", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".mendcode", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".mendcode", "skill", "dir-skill"))
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .mendcode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".mendcode", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".mendcode", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".mendcode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).find((x) => x.name === "no-frontmatter")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("does not surface invalid external skills as session errors", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".claude", "skills", "invalid-external", "SKILL.md"),
                "# This file is missing frontmatter\n",
              ),
            )

            const bus = yield* Bus.Service
            const errors: unknown[] = []
            const unsubscribe = yield* bus.subscribeCallback(Session.Event.Error, (event) => errors.push(event))
            const skill = yield* Skill.Service
            expect(yield* skill.get("invalid-external")).toBeUndefined()
            yield* Effect.sleep("50 millis")
            unsubscribe()
            expect(errors).toHaveLength(0)
          }),
        ),
      { git: true },
    ),
  )

  it.live("retries a skill while its frontmatter is being written", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillPath = path.join(dir, ".mendcode", "skill", "transient-skill", "SKILL.md")
          const valid = `---
name: transient-skill
description: A skill that becomes valid after an in-progress write.
---

# Transient Skill
`
          yield* Effect.promise(() => Bun.write(skillPath, "# Incomplete while the editor is writing\n"))
          const finishWrite = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              Bun.write(skillPath, valid).then(() => resolve(), reject)
            }, 25)
          })

          const skill = yield* Skill.Service
          yield* Effect.promise(() => finishWrite)
          expect(yield* skill.get("transient-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .claude/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const item = list.find((x) => x.name === "claude-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from the legacy global skills directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = yield* skill.all()
            const item = list.find((x) => x.name === "global-test-skill")
            expect(item).toBeDefined()
            expect(item!.description).toBe("A global skill from the legacy global skills directory for testing.")
            expect(item!.location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect((yield* skill.all()).find((x) => x.location.includes("opencode-test-") || x.name === "missing-test-skill")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = yield* skill.all()
            const item = list.find((x) => x.name === "global-agent-skill")
            expect(item).toBeDefined()
            expect(item!.description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(item!.location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from both .claude/skills/ and .agents/skills/", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.find((x) => x.name === "claude-skill")).toBeDefined()
          expect(list.find((x) => x.name === "agent-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".mendcode", "skill", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .mendcode/skill directory.
---

# MendCode Skill
`,
              ),
              Bun.write(
                path.join(dir, ".mendcode", "skills", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .mendcode/skills directory.
---

# MendCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const dirs = yield* skill.dirs()
          expect(dirs).toContain(path.join(dir, ".claude", "skills", "claude-skill"))
          expect(dirs).toContain(path.join(dir, ".agents", "skills", "agent-skill"))
          expect(dirs).toContain(path.join(dir, ".mendcode", "skill", "agent-skill"))
          expect(dirs).toContain(path.join(dir, ".mendcode", "skills", "agent-skill"))
        }),
      { git: true },
    ),
  )

  it.live("discovers compat skills from .opencode/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skills", "repo-orient", "SKILL.md"),
              `---
name: repo-orient
description: Compat skill imported from an OpenCode-style folder.
---

# Repo Orient
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((x) => x.name === "repo-orient")
          expect(item).toBeDefined()
          expect(item!.source).toBe("compat-opencode")
          expect(item!.location).toContain(path.join(".opencode", "skills", "repo-orient", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers compat skills from .opencode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "singular-compat", "SKILL.md"),
              `---
name: singular-compat
description: Compat skill from the singular OpenCode-style folder.
---

# Singular Compat
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((x) => x.name === "singular-compat")
          expect(item).toBeDefined()
          expect(item!.source).toBe("compat-opencode")
          expect(item!.location).toContain(path.join(".opencode", "skill", "singular-compat", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("keeps MendCode and compat skills side by side", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skills", "compat-only", "SKILL.md"),
                `---
name: compat-only
description: Compat-only skill.
---

# Compat Only
`,
              ),
              Bun.write(
                path.join(dir, ".mendcode", "skills", "mend-only", "SKILL.md"),
                `---
name: mend-only
description: MendCode-first skill.
---

# Mend Only
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = yield* skill.all()
          expect(list.find((x) => x.name === "compat-only")!.source).toBe("compat-opencode")
          expect(list.find((x) => x.name === "mend-only")!.source).toBe("mendcode")
        }),
      { git: true },
    ),
  )

  it.live("prefers .mendcode skills over .opencode compat skills with the same name", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skills", "shared", "SKILL.md"),
                `---
name: shared
description: Compat version.
---

# Compat Shared
`,
              ),
              Bun.write(
                path.join(dir, ".mendcode", "skills", "shared", "SKILL.md"),
                `---
name: shared
description: MendCode version.
---

# Mend Shared
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const item = yield* skill.get("shared")
          expect(item).toBeDefined()
          expect(item!.source).toBe("mendcode")
          expect(item!.description).toBe("MendCode version.")
          expect(item!.location).toContain(path.join(".mendcode", "skills", "shared", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("prefers the closest project skill when parent and child directories define the same name", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const child = path.join(tmp.path, "packages", "nested")
      yield* Effect.promise(() => fs.mkdir(child, { recursive: true }))
      yield* Effect.promise(() =>
        Promise.all([
          writeSkill(path.join(tmp.path, ".mendcode", "skills", "shared-project-skill", "SKILL.md"), {
            name: "shared-project-skill",
            description: "Parent project skill.",
            heading: "Parent Skill",
          }),
          writeSkill(path.join(child, ".mendcode", "skills", "shared-project-skill", "SKILL.md"), {
            name: "shared-project-skill",
            description: "Child project skill.",
            heading: "Child Skill",
          }),
        ]),
      )

      yield* Effect.gen(function* () {
        const skill = yield* Skill.Service
        const item = yield* skill.get("shared-project-skill")
        expect(item).toBeDefined()
        expect(item!.description).toBe("Child project skill.")
        expect(item!.location).toContain(path.join("packages", "nested", ".mendcode", "skills", "shared-project-skill", "SKILL.md"))
      }).pipe(provideInstance(child))
    }),
  )

  it.live("hot reloads a newly created MendCode skill without recreating the service", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const bus = yield* Bus.Service
          expect(yield* skill.get("hot-skill")).toBeUndefined()

          const skillPath = path.join(dir, ".mendcode", "skills", "hot-skill", "SKILL.md")
          yield* Effect.promise(() =>
            Bun.write(
              skillPath,
              `---
name: hot-skill
description: Hot reloaded MendCode skill.
---

# Hot Skill
`,
            ),
          )

          yield* bus.publish(FileWatcher.Event.Updated, { file: skillPath, event: "add" })
          const item = yield* waitForSkill(skill.get("hot-skill"), Boolean)
          expect(item).toBeDefined()
          expect(item!.source).toBe("mendcode")
        }),
      { git: true },
    ),
  )

  it.live("hot reloads deleted skills out of the registry", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillPath = path.join(dir, ".mendcode", "skills", "deleted-skill", "SKILL.md")
          yield* Effect.promise(() =>
            Bun.write(
              skillPath,
              `---
name: deleted-skill
description: Skill that will be deleted.
---

# Deleted Skill
`,
            ),
          )

          const skill = yield* Skill.Service
           const bus = yield* Bus.Service
           expect(yield* skill.get("deleted-skill")).toBeDefined()
           yield* Effect.sleep("150 millis")

           yield* Effect.promise(() => fs.rm(skillPath))
          yield* bus.publish(FileWatcher.Event.Updated, { file: skillPath, event: "unlink" })
          expect(yield* waitForSkill(skill.get("deleted-skill"), (item) => item === undefined)).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
