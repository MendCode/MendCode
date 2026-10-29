import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { fixturePng } from "../../tools/test/pet-fixture"
import { READ_ONLY_COMMANDS } from "../../protocol/src/remote"
import type { PetPlan } from "../../protocol/src/pet-data"

test("a remote client cannot plan or generate, and no image call is made", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-remote-"))
  let calls = 0
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), petImages: async () => { calls++; return { ok: true, model: "test-image", images: [{ type: "png", bytes: fixturePng() }] } } })
  const local = createClient({ socketPath: daemon.socketPath, name: "pet-local" })
  const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
  const remote = createClient({ name: "pet-remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  try {
    await local.connect()
    await remote.connect()
    expect(await local.send({ type: "settings.set", patch: { tier: "full", image_generation: { enabled: true, model: "openai/test-image" } } })).toMatchObject({ ok: true })
    expect(await remote.send({ type: "pet.manage", input: { action: "plan", description: "blue owl", unitUsd: 0.1 } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    const planned = await local.send({ type: "pet.manage", input: { action: "plan", description: "blue owl" } })
    if (!planned.ok) throw new Error(planned.error.message)
    const plan = planned.result!.plan as PetPlan
    expect(await remote.send({ type: "pet.manage", input: { action: "generate", planId: plan.planId, confirmed: true } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(calls).toBe(0)
  } finally {
    remote.close()
    local.close()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Unix daemon routes plans and confirmed fake calls without provider credentials", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-ipc-"))
  let calls = 0
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), petImages: async () => { calls++; return { ok: true, model: "test-image", images: [{ type: "png", bytes: fixturePng() }] } } })
  const client = createClient({ socketPath: daemon.socketPath, name: "pet-test" })
  try {
    await client.connect()
    expect(READ_ONLY_COMMANDS).not.toContain("pet.manage")
    expect(await client.send({ type: "settings.set", patch: { tier: "full", image_generation: { enabled: true, model: "openai/test-image" } } })).toMatchObject({ ok: true })
    const planned = await client.send({ type: "pet.manage", input: { action: "plan", description: "blue owl", unitUsd: 0.1 } })
    expect(planned.ok).toBe(true)
    expect(calls).toBe(0)
    if (!planned.ok) throw new Error(planned.error.message)
    const plan = planned.result!.plan as PetPlan
    expect(await client.send({ type: "pet.manage", input: { action: "generate", planId: plan.planId, confirmed: true } })).toMatchObject({ ok: true })
    expect(calls).toBe(6)
  } finally {
    client.close()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
