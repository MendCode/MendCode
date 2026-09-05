import { afterEach, expect, test } from "bun:test"
import { Flag } from "@mendcode/core/flag/flag"
import { Server } from "../../src/server/server"
import { readChannel, writeChannel } from "../../src/installation/release-channel"

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await writeChannel("stable")
})

test.each([false, true])("release channel preference uses the selected backend (HttpApi=%s)", async (experimental) => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  const app = experimental ? Server.Default().app : Server.Legacy().app
  await writeChannel("stable")
  const before = await app.request("/global/release-channel")
  expect(before.status).toBe(200)
  expect(await before.json()).toEqual({ channel: "stable" })
  const changed = await app.request("/global/release-channel", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "nightly" }),
  })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toEqual({ channel: "nightly" })
  expect(await readChannel()).toBe("nightly")
  const invalid = await app.request("/global/release-channel", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "preview" }),
  })
  expect(invalid.status).toBe(400)
  expect(await readChannel()).toBe("nightly")
})
