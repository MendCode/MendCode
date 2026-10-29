import { expect, test } from "bun:test"
import { Command, createIdFactory, TsmChange, TsmRead } from "../src"
import { isReadOnlyCommand } from "../src/wire"

test("B72 additive TSM commands separate probes from scaffold writes; neither is remote read-only", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client"), directory: "/repo" }
  for (const operation of ["status", "doctor"] as const) expect(Command.safeParse({ ...base, type: "tsm.query", query: { operation } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "tsm.query", query: { operation: "open", target: "mend/client" } }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "tsm.query", query: { operation: "create", input: { name: "client" } } }).success).toBe(true)
  for (const operation of ["plan", "install", "setup", "activate", "deactivate", "remove"] as const) expect(Command.safeParse({ ...base, type: "tsm.change", change: { operation } }).success).toBe(true)
  expect(isReadOnlyCommand("tsm.query")).toBe(false)
  expect(isReadOnlyCommand("tsm.change")).toBe(false)
})
test("B72 rejects execution, unknown mux, excess fields and unbounded/control-character targets", () => {
  for (const query of [{ operation: "open" }, { operation: "open", target: "unsafe\n" }, { operation: "open", target: "x".repeat(4097) }, { operation: "create", input: { name: "x".repeat(101) } }, { operation: "status", execute: true }]) expect(TsmRead.safeParse(query).success).toBe(false)
  for (const change of [{ operation: "activate", muxBackend: "tmux" }, { operation: "setup", execute: true }, { operation: "remove", force: true }, { operation: "plan", muxBackend: "kitty" }]) expect(TsmChange.safeParse(change).success).toBe(false)
  for (const muxBackend of ["auto", "cmux", "kitty", "ghostty", "wezterm"]) expect(TsmChange.safeParse({ operation: "activate", muxBackend }).success).toBe(true)
})
