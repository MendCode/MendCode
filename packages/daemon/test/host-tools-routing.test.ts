import { expect, test } from "bun:test"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { SessionId } from "@mendcode/protocol"
import { withAcpEngine } from "@mendcode/engine-acp"
import { withPiEngine } from "@mendcode/engine-pi"
import { withCodexEngine } from "../src/codex-router"

const IMAGE_GEN = { name: "image_gen", description: "Generate an image", parameters: { type: "object", properties: {} } }

test("MendCode's tools reach a Claude Code session through every engine wrapper the daemon stacks (ACP, Codex, pi)", async () => {
  const calls: string[] = []
  const base: EnginePort = {
    runTurn: async () => ({ status: "ok" }),
    needsCompaction: () => false,
    compact: async () => ({ status: "ok" }),
    hostTools: async () => [IMAGE_GEN],
    hostCall: async ({ name }) => { calls.push(name); return { output: "saved image.png", isError: false } },
  }
  const unused = async (): Promise<never> => { throw new Error("no other engine is loaded for host tools") }
  const stacked = withPiEngine({
    base: withCodexEngine({ base: withAcpEngine({ base, acp: unused, usesAcp: () => false }), usesCodex: () => false, create: unused }),
    pi: unused,
    usesPi: () => false,
  })
  const sessionId = "ses_host" as SessionId
  expect(await stacked.hostTools?.({ directory: "/project", sessionId })).toEqual([IMAGE_GEN])
  const result = await stacked.hostCall?.({ turn: { sessionId } as TurnInput, name: "image_gen", args: { prompt: "a drop of water" } })
  expect(result).toEqual({ output: "saved image.png", isError: false })
  expect(calls).toEqual(["image_gen"])
})
