import { expect, test } from "bun:test"
import type { SkillsReport } from "@mendcode/protocol"
import { slashCollisions } from "../src/view/commands"
import { skillFacts, skillOptions } from "../src/view/skills-page"

const skill = (name: string, extra: Partial<SkillsReport["skills"][number]> = {}): SkillsReport["skills"][number] => ({ name, description: `${name} skill`, source: "user", dir: `/skills/${name}`, enabled: true, ...extra })

test("user-invocable false hides a skill from the skills page; the facts list layer, ignored fields, notes and overrides", () => {
  const report: SkillsReport = {
    skills: [skill("shown", { layer: "project", ignoredFields: ["context"], notes: ["allowed-tools (Read) is not applied"] }), skill("internal", { userInvocable: false }), skill("manual", { disableModelInvocation: true })],
    findings: { overridden: [{ kind: "skill", name: "shown", layer: "user", by: "project" }], dropped: [], ignored: [], notes: [], problems: [] },
  }
  expect(skillOptions(report, "").map((entry) => entry.name)).toEqual(["manual", "shown"])
  expect(skillFacts(report.skills[0]!, report)).toEqual(["layer: project", "ignored fields: context", "note: allowed-tools (Read) is not applied", "overrides user"])
  expect(skillFacts(report.skills[2]!, report)).toEqual(["only you can run it: /manual"])
})

test("a skill or command named like a terminal built-in is reported as shadowed, a built-in daemon command is not", () => {
  expect(slashCollisions([{ name: "model", skill: true, source: "user" }, { name: "usage", source: "project" }, { name: "fresh-name", source: "user" }, { name: "commit", source: "builtin" }])).toEqual([
    "skill model (user) is overridden by the built-in /model",
    "command usage (project) is overridden by the built-in /usage",
  ])
})
