import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { acquireChannelTransition, parseChannel, readChannel, selectRelease, writeChannel } from "../../src/installation/release-channel"

const releases = [
  { tag_name: "v0.2.0-nightly.20260905.1", prerelease: true },
  { tag_name: "v0.2.0-beta.2", prerelease: true },
  { tag_name: "v0.2.0-beta.10", prerelease: true },
  { tag_name: "v0.1.43", prerelease: false },
  { tag_name: "v9.0.0", draft: true },
  { tag_name: "invalid" },
]

test("channels never select another prerelease track or a draft", () => {
  expect(selectRelease(releases, "stable")).toBe("0.1.43")
  expect(selectRelease(releases, "beta")).toBe("0.2.0-beta.10")
  expect(selectRelease(releases, "nightly")).toBe("0.2.0-nightly.20260905.1")
  expect(selectRelease([{ tag_name: "v0.1.43" }], "beta")).toBeUndefined()
  expect(selectRelease([{ tag_name: "v0.2.0-beta.1", prerelease: false }], "stable")).toBeUndefined()
})

test("invalid channel cannot silently select stable", () => {
  expect(() => parseChannel("preview")).toThrow("stable, beta, or nightly")
})

test("an active transition blocks preference changes in this and another process", async () => {
  await writeChannel("stable")
  const lock = await acquireChannelTransition()
  try {
    await expect(writeChannel("beta")).rejects.toThrow("release-channel lock")
    const home = process.env.OPENCODE_TEST_HOME
    if (!home) throw new Error("Isolated test home is required")
    const child = Bun.spawn([process.execPath, "-e", `
      import { writeChannel } from "./src/installation/release-channel.ts";
      if (process.env.OPENCODE_TEST_HOME !== ${JSON.stringify(home)}) throw new Error("Missing child test isolation");
      await writeChannel("beta").catch((error) => { console.error(error.message); process.exitCode = 1; });
    `], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 5000,
      env: { PATH: process.env.PATH ?? "", HOME: home, OPENCODE_TEST_HOME: home, MENDCODE_TEST_HOME: home, MENDCODE_DB: ":memory:" },
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("release-channel lock")
    expect(await readChannel()).toBe("stable")
    await lock.commit("beta")
    expect(await readChannel()).toBe("beta")
  } finally {
    await lock.release()
    await writeChannel("stable")
  }
})
