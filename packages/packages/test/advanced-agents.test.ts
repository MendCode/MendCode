import { expect, test } from "bun:test"
import { parseAgentFile } from "../src/agents"

const parse = (body: string, stem = "build") => parseAgentFile({ text: `---\n${body}\n---\nBuiltin prompt override.`, stem, file: "test.md", source: "user" })

test("builtin overrides parse nested YAML, deprecated steps, tools maps and arbitrary generation options", () => {
  const result = parse("model: local:fast\nvariant: quick\ntemperature: 0.6\ntop_p: 0.8\ncolor: accent\nhidden: true\nmaxSteps: 4\noptions:\n  seed: 7\nfrequency_penalty: 0.1\ntools:\n  read: true\n  write: false")
  expect(result).toMatchObject({ agent: { name: "build", mode: "primary", prompt: "Builtin prompt override.", steps: 4, options: { seed: 7, frequency_penalty: 0.1 }, permissionRules: [{ permission: "read", pattern: "*", action: "allow" }, { permission: "edit", pattern: "*", action: "deny" }] } })
})

test("steps takes precedence over maxSteps, and disabled stubs need no description", () => {
  expect(parse("steps: 2\nmaxSteps: 5")).toMatchObject({ agent: { steps: 2 } })
  expect(parse("disable: true", "old")).toMatchObject({ agent: { name: "old", disable: true } })
})

test("malformed advanced properties fail visibly rather than being silently ignored", () => {
  for (const yaml of ["steps: 0", "temperature: nope", "hidden: maybe", "color: '#abc'", "options:\n  messages: []", "tools:\n  read: maybe"]) expect(parse(yaml)).toHaveProperty("problem")
})
