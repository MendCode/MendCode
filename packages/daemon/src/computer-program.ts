import { executeCode } from "@mendcode/engine-native"
import type { ComputerCodeReport } from "@mendcode/protocol"

/** computer_code runs on the same confined interpreter as Code Mode, with only bounded computer operations. */
const TOOLS = ["observe", "press", "setValue", "click", "typeText", "key", "scroll", "drag", "windows", "selectWindow", "waitFor", "status"] as const
const LIMITS = { maxToolCalls: 16, maxOutputBytes: 65_536, timeoutMs: 30_000, maxOperations: 20_000 }

export async function runComputerProgram(code: string, signal: AbortSignal, invoke: (name: string, input: unknown) => Promise<unknown>): Promise<ComputerCodeReport> {
  const result = await executeCode({ code, names: TOOLS, signal, limits: LIMITS, invoke: (name, input) => invoke(name, input) })
  return {
    ok: result.ok,
    ...(result.ok ? { value: result.value } : { error: result.error ?? { kind: "ExecutionFailure", message: "Computer code failed" } }),
    toolCalls: result.toolCalls,
    ...(result.logs?.length ? { logs: result.logs } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  }
}
