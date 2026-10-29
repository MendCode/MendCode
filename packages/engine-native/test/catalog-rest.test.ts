import { expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { scriptedProvider } from "./harness"

test("B83 native catalog uses real project schemas and live permissions without running tools or a model", async () => {
  const { provider, requests } = scriptedProvider([])
  let executions = 0
  const tool = (name: string) => defineTool({ name, description: `Local ${name}`, permission: "read", args: z.object({ file: z.string() }), execute: async () => { executions++; throw new Error("Must not execute") } })
  const directories: string[] = []
  const policy = { permission: { denied: "deny" as const } }
  const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [tool("read"), tool("denied")], cwdFor: () => "/project", system: () => "sys", compactionPrompt: "summary", permissionPolicy: () => policy,
    projectTools: async (directory) => { directories.push(directory); return [tool("local_custom")] },
  })
  const catalog = await engine.catalogTools!({ directory: "/project" })
  expect(catalog.find((entry) => entry.id === "read")).toMatchObject({ description: "Local read", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } })
  expect(catalog.some((entry) => entry.id === "local_custom")).toBe(true)
  expect(catalog.some((entry) => entry.id === "denied")).toBe(false)
  expect(directories).toEqual(["/project"])
  expect(requests).toEqual([])
  expect(executions).toBe(0)
})
