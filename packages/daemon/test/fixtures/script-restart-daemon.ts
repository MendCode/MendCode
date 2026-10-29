/**
 * A real daemon process for the restart test: `bun script-restart-daemon.ts <dataDir>`. Faux engine; every turn appends its
 * task title to `<dataDir>/turns.log`, and a task whose title starts with "gate-" hangs until `<dataDir>/open` exists.
 * Prints `ready <socket>` once it listens.
 */
import { appendFileSync, existsSync } from "node:fs"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../../src"

const dir = process.argv[2]!
const daemon = await startDaemon({
  dir,
  socketPath: path.join(dir, "mendd.sock"),
  engine: ({ clock }) => {
    const faux = createFauxEngine({ clock, deltaMs: 1 })
    return {
      ...faux,
      runTurn(input) {
        const title = /Your task: (.*)/.exec(input.text)?.[1]?.trim() ?? "?"
        appendFileSync(path.join(dir, "turns.log"), `${title}\n`)
        if (title.startsWith("gate-") && !existsSync(path.join(dir, "open"))) return faux.runTurn({ ...input, text: "/hang" })
        return faux.runTurn({ ...input, text: `/say ok:${title}` })
      },
    }
  },
})
console.log(`ready ${daemon.socketPath}`)
setInterval(() => {}, 1 << 30)
