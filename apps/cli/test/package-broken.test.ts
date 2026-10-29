import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, extension, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

/** A good package next to a broken one: the app must start, draw, take input, and the good package must still work. */
async function open(broken: (dir: ReturnType<typeof scratch>) => void) {
  const dir = scratch()
  made.push(dir)
  dir.write("data/packages/good/mendcode-package.json", JSON.stringify({ name: "good", version: "1.0.0", description: "works" }))
  dir.write("data/packages/good/extensions/tag.ts", extension("tag", "api.markdown((t) => t + ' [good]')"))
  broken(dir)
  const h = await appHarness({ dataDir: dir.dataDir, directory: dir.project, width: 120, height: 36 })
  await h.start({ onboarded: true } as never)
  h.message("question", "hi")
  return { h, dir }
}

describe("a broken package never stops the app from starting", () => {
  test("an extension that throws on load: reported, the good package still applies", async () => {
    const { h } = await open((dir) => {
      dir.write("data/packages/boom/mendcode-package.json", JSON.stringify({ name: "boom", version: "1.0.0", description: "throws" }))
      dir.write("data/packages/boom/extensions/boom.ts", extension("boom", "throw new Error('boom on load')"))
    })
    expect(h.text()).toContain("hi [good]")
    await h.type("/help\r")
    expect(h.text()).toContain("boom on load")
  })

  test("an invalid manifest: the app starts and the good package applies (the daemon lists the broken one with its problem)", async () => {
    const { h } = await open((dir) => {
      dir.write("data/packages/bad/mendcode-package.json", "{ not json")
      dir.write("data/packages/bad/extensions/x.ts", extension("x", "api.markdown((t) => t + ' [bad]')"))
    })
    expect(h.text()).toContain("[good]")
    await h.key("\x1b")
  })

  test("an activation naming a module that is not there: the app starts and the look is applied without it", async () => {
    const { h } = await open((dir) => {
      dir.write("data/packages/ghost/mendcode-package.json", JSON.stringify({ name: "ghost", version: "1.0.0", description: "g", activate: { tuiProfile: { username: "Ghost" }, views: { "message.assistant": "extensions/gone" } } }))
    })
    expect(h.text()).toContain("hi [good]")
    expect(h.app.accessibility.profile.username).toBe("Ghost")
  })

  test("a view over the time budget is given up on after three strikes; the built-in draws again", async () => {
    const dir = scratch()
    made.push(dir)
    dir.write("data/packages/slow/mendcode-package.json", JSON.stringify({ name: "slow", version: "1.0.0", description: "slow view" }))
    dir.write("data/packages/slow/extensions/slow.ts", extension("slow", `api.view("message.assistant", (m) => { const start = Date.now(); while (Date.now() - start < 15) {} return [[{ text: "SLOW<" + m.text + ">" }]] })`))
    const h = await appHarness({ dataDir: dir.dataDir, directory: dir.project, width: 120, height: 36 })
    await h.start({ onboarded: true } as never)
    h.message("question", "hello there")
    for (let i = 0; i < 8; i++) h.app.render()
    expect(h.text()).not.toContain("SLOW<")
    expect(h.text()).toContain("hello there")
  })

  test("a view that throws on every call is given up on too", async () => {
    const dir = scratch()
    made.push(dir)
    dir.write("data/packages/crash/mendcode-package.json", JSON.stringify({ name: "crash", version: "1.0.0", description: "throws" }))
    dir.write("data/packages/crash/extensions/crash.ts", extension("crash", `api.view("message.assistant", () => { throw new Error("view crash") })`))
    const h = await appHarness({ dataDir: dir.dataDir, directory: dir.project, width: 120, height: 36 })
    await h.start({ onboarded: true } as never)
    h.message("question", "still here")
    for (let i = 0; i < 6; i++) h.app.render()
    expect(h.text()).toContain("still here")
  })
})
