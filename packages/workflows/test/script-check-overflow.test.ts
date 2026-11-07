import { expect, test } from "bun:test"
import { scriptHarness, settle } from "./script-harness"

for (const fullTruncated of [false, true]) {
  test(`runner overflow ${fullTruncated} reaches the script and journal even with a short full output`, async () => {
    const h = scriptHarness({
      runCheck: async ({ fullOutput }) => {
        expect(fullOutput).toBe(true)
        return { exitCode: 0, output: "LAST", full: "HEADER\n \n", fullTruncated }
      },
    })
    const run = h.start(`
      export const meta = { name: "overflow", description: "test", phases: [{ title: "Check" }] }
      const result = await check("fixture")
      return { detail: result.detail, truncated: result.truncated }
    `)
    await settle(30)
    const done = h.get(run)
    expect(done.state).toBe("completed")
    expect(JSON.parse(done.script!.result!)).toEqual({ detail: "exit 0\nHEADER", truncated: fullTruncated })
    const entry = [...h.rows.values()].map((payload) => JSON.parse(payload)).find((value) => value.kind === "check")
    expect(entry).toBeDefined()
    expect(entry.truncated === true).toBe(fullTruncated)
  })
}
