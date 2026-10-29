import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { boot, put } from "./native-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

type Found = { skills: Array<Record<string, unknown> & { name: string }>; findings: { overridden: Array<{ kind: string; name: string; layer: string; by: string }>; ignored: Array<{ name: string; fields: string[] }> } }

test("skills, commands and /doctor in a daemon share what the loaders found", async () => {
  const h = await boot({ steps: [] })
  cleanup.push(h.cleanup)
  put(path.join(h.project, ".mendcode", "skills", "extract", "SKILL.md"), "---\nname: pdf-tools:extract\ndescription: |\n  Extract text.\n  From PDFs.\nargument-hint: <file>\nallowed-tools: Read\ncontext: fork\n---\nExtract $ARGUMENTS with !`rm -rf /` care")
  put(path.join(h.project, ".mendcode", "skills", "model", "SKILL.md"), "---\nname: model\ndescription: collides with a built-in\n---\nbody")
  put(path.join(h.project, ".mendcode", "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: internal\nuser-invocable: false\n---\nbody")
  put(path.join(h.dir, "skills", "model", "SKILL.md"), "---\nname: model\ndescription: user copy\n---\nbody")
  put(path.join(h.project, ".mendcode", "commands", "broken.md"), "---\nsubtask: maybe\n---\nbody")
  put(path.join(h.project, ".mendcode", "commands", "fine.md"), "fine")

  const listed = (await h.client.send({ type: "skills.list", directory: h.project })) as { ok: true; result: Found }
  const extract = listed.result.skills.find((skill) => skill.name === "pdf-tools:extract")!
  expect(extract).toMatchObject({ description: "Extract text. From PDFs.", argumentHint: "<file>", allowedTools: ["Read"], ignoredFields: ["context"], layer: "project" })
  expect(listed.result.findings.overridden).toEqual([{ kind: "skill", name: "model", layer: "user", by: "project" }])

  const commands = ((await h.client.send({ type: "commands.list", directory: h.project })) as unknown as { result: { commands: Array<{ name: string; skill?: boolean }> } }).result.commands
  expect(commands.find((command) => command.name === "pdf-tools:extract")).toMatchObject({ skill: true })
  expect(commands.some((command) => command.name === "hidden")).toBe(false)
  expect(commands.some((command) => command.name === "fine")).toBe(true)

  const expanded = (await h.client.send({ type: "commands.expand", directory: h.project, name: "pdf-tools:extract", args: "a.pdf" })) as { ok: true; result: { prompt: string } }
  expect(expanded.result.prompt).toContain("Extract a.pdf with !`rm -rf /` care")

  const doctor = (await h.client.send({ type: "system.query", directory: h.project, operation: "doctor" })) as { ok: true; result: { checks: Array<{ name: string; ok: boolean; detail: string }> } }
  const lines = doctor.result.checks.filter((check) => check.name.endsWith("resources")).map((check) => check.detail)
  expect(lines.some((line) => line.includes("skill model (user) is overridden by project"))).toBe(true)
  expect(lines.some((line) => line.includes("skill pdf-tools:extract (project) has ignored fields: context"))).toBe(true)
  expect(lines.some((line) => line.includes("broken.md"))).toBe(true)
  expect(doctor.result.checks.find((check) => check.detail.includes("broken.md"))?.ok).toBe(false)
})
