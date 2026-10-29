import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, plain, tempDir } from "../apps/cli/test/session-ui-harness"
import { LESSONS } from "../apps/cli/src/tutorial/lessons"
import { fit } from "../apps/cli/src/view/deck"

// bun scripts/render-tutorial-frames.ts <directory> [lessons|sizes] [WxH ...]
//   lessons: every lesson of the tour at the first size (default 100x30), at its start and once `show me` has done it.
//   sizes:   the first lesson and the end screen at each size.
const target = process.argv[2]
if (!target) throw new Error("usage: render-tutorial-frames.ts <directory> [lessons|sizes] [WxH ...]")
const directory: string = target
const phase = process.argv[3] === "sizes" ? "sizes" : "lessons"
const sizes = process.argv.slice(4).filter((arg) => /^\d+x\d+$/.test(arg))
mkdirSync(directory, { recursive: true })

async function until(check: () => boolean, ms = 30_000) {
  const started = Date.now()
  while (!check() && Date.now() - started < ms) await Bun.sleep(25)
}

async function open(width: number, height: number, args: string) {
  const h = appHarness({ width, height, env: { TERM: "xterm-256color" }, directory: "/work/app", dataDir: tempDir() })
  await h.type(`/tutorial${args}\r`)
  await until(() => h.app.page === "tutorial")
  await Bun.sleep(30)
  const frame = () => { h.app.render(); return (h.frames.at(-1) ?? []).map(plain) }
  const save = (name: string) => writeFileSync(path.join(directory, `${name}-${width}x${height}.txt`), `${frame().map((row) => fit([{ text: row }], width).map((span) => span.text).join("")).join("\n")}\n`)
  return { h, frame, save }
}

if (phase === "lessons") {
  const [width, height] = (sizes[0] ?? "100x30").split("x").map(Number) as [number, number]
  const { h, frame, save } = await open(width, height, " all")
  for (let i = 0; i < LESSONS.length; i++) {
    const name = `lesson-${String(i + 1).padStart(2, "0")}-${LESSONS[i]!.id}`
    save(`${name}-start`)
    await h.type("\x1bm")
    await until(() => frame().join("\n").includes("done · enter") || frame().join("\n").includes("Tutorial complete"))
    save(`${name}-done`)
    await h.type("\r")
    await Bun.sleep(60)
  }
  save("end")
} else {
  for (const size of sizes.length ? sizes : ["60x20", "80x24", "100x30", "130x32", "200x60"]) {
    const [width, height] = size.split("x").map(Number) as [number, number]
    const { h, frame, save } = await open(width, height, "")
    save("lesson-01-start")
    await h.type("\x1bm")
    await until(() => frame().join("\n").includes("done · enter"))
    save("lesson-01-done")
    const open2 = await open(width, height, " restart")
    for (let i = 0; i < LESSONS.length; i++) await open2.h.type("\x1bs")
    open2.save("end")
  }
}
cleanTemps()
process.exit(0)
