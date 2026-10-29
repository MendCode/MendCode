import { writeFileSync } from "node:fs"
import path from "node:path"
import { uninstallHarness } from "../apps/cli/test/uninstall-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/** Exercises the production local review factory. Uninstall deliberately never starts a daemon. */
export async function renderB76Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    for (const [name, args, lock] of [
      ["uninstall-review", [], false],
      ["uninstall-dry-run", ["--dry-run"], false],
      ["uninstall-keep-config", ["--keep-config"], false],
      ["uninstall-keep-data", ["--keep-data"], false],
      ["uninstall-keep-both", ["--keep-config", "--keep-data"], false],
      ["uninstall-active-daemon", [], true],
    ] as const) {
      const h = uninstallHarness()
      try {
        if (lock) writeFileSync(path.join(h.dir, "mendd.lock"), "4242")
        const ui = h.ui(width, height, [...args], lock ? { alive: () => true } : {})
        const save = (suffix: string) => {
          const frame = ui.frames.at(-1)!
          const text = frame.map((row) => row.map((span) => span.text).join("")).join("\n")
          if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) !== width) || text.includes("\x1b")) throw new Error(`invalid frame ${name} ${size}`)
          writeFileSync(path.join(directory, `${name}${suffix}-${size}.txt`), text + "\n")
        }
        save("")
        // Record all target rows and blockers, including those below the first viewport.
        let previous = ui.frames.at(-1)!.map((row) => row.map((span) => span.text).join("")).join("\n")
        for (let page = 2; page <= 20; page++) {
          ui.app.key("\x1b[6~")
          const next = ui.frames.at(-1)!.map((row) => row.map((span) => span.text).join("")).join("\n")
          if (next === previous) break
          save(`-p${page}`)
          previous = next
        }
        ui.app.key("\x1b")
      } finally { h.cleanup() }
    }
  }
}
