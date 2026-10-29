import { createKeyboardProtocol, KEYBOARD_FLAGS, translateKey } from "../apps/cli/src/ui/keyboard-protocol"
import { tokenizeKeys } from "../apps/cli/src/ui/keys"
import { keyName } from "../apps/cli/src/ui/keymap"
import { isAltSequence } from "../apps/cli/src/view/option-keys"

/**
 * What the terminal sends for each key, with the keyboard modes MendCode asks for on a Mac. Run `bun scripts/key-probe.ts`, press
 * Option+Q, Option+L, Option+Up (and anything else) and paste the lines; ctrl+c leaves and restores the terminal. `--legacy` skips
 * the keyboard protocol and shows what the terminal sends without it.
 *
 * Each line: the raw bytes of one key, the key MendCode reads from them (the translation the app uses), its name, and whether it
 * counts as Alt (if not, Option+Q is only the character it composed).
 */
const legacy = process.argv.includes("--legacy")
const out = (text: string) => process.stdout.write(text)
const show = (raw: string) => raw.replace(/[\x00-\x1f\x7f]/g, (char) => char === "\x1b" ? "ESC" : `^${String.fromCharCode(char.charCodeAt(0) ^ 64)}`)
const protocol = createKeyboardProtocol({ write: out, enabled: !legacy })

function leave() {
  out(`${protocol.release()}\x1b[?2004l\n`)
  process.stdin.setRawMode?.(false)
  process.exit(0)
}

if (!process.stdin.isTTY) throw new Error("key-probe needs a terminal")
process.stdin.setRawMode(true)
process.on("exit", () => out(protocol.release()))
process.once("SIGTERM", leave)
out(`TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""} TERM=${process.env.TERM ?? ""} flags=${legacy ? "none (--legacy)" : KEYBOARD_FLAGS}\n`)
out("\x1b[?2004h")
protocol.ask()
out(legacy ? "keys arrive as the terminal sends them; ctrl+c leaves\n" : "asking the terminal for the keyboard protocol; ctrl+c leaves\n")
process.stdin.on("data", (data: Buffer) => {
  const before = protocol.state
  const rest = protocol.consume(data.toString())
  if (before !== protocol.state) out(`protocol: ${protocol.state}${protocol.state === "on" ? ` (flags ${KEYBOARD_FLAGS} pushed)` : protocol.state === "refused" ? " (the terminal does not answer the query, keys are legacy)" : ""}\n`)
  for (const token of tokenizeKeys(rest)) {
    const raw = token.type === "key" ? token.seq : `\x1b[200~${token.text}\x1b[201~`
    const key = protocol.active ? translateKey(raw) : raw
    if (key === "\x03") return leave()
    out(`raw ${show(raw)}  ${JSON.stringify(raw)}  key ${JSON.stringify(key)}  name ${keyName(key) ?? "-"}  alt ${isAltSequence(key)}\n`)
  }
})
