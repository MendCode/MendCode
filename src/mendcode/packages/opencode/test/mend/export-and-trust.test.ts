import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { exportPlan } from "../../src/mend/runtime/export"
import { digestApplicableSource, isApplyAllowed } from "../../src/mend/runtime/registry/trust"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("mend export and trust policy", () => {
  test("exports mend package manifests as safe shareable artifacts", () => {
    const plan = exportPlan()

    expect(plan.safe).toContain("mend-package.json")
    expect(plan.safe).toContain(".mendcode/package.json")
  })

  test("allows mend package manifests in apply filtering", () => {
    expect(isApplyAllowed("mend-package.json")).toBe(true)
    expect(isApplyAllowed(".mendcode/package.json")).toBe(true)
  })

  test("digests direct mend-package file sources when no runtime-pack exists", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, "mend-package.json"), {
      version: 0,
      id: "starter-file",
      title: "Starter File",
    })

    const digest = await digestApplicableSource(dir.path)
    expect(digest.value).toMatch(/^[a-f0-9]{64}$/)
    expect(digest.files).toEqual(["mend-package.json"])
  })
})
