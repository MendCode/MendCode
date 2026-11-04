import { AsyncLocalStorage } from "node:async_hooks"

/** The live output of the computer tool that is running, so a wait inside the daemon (for a permission) can say so while the call stays open. */
export const computerOutput = new AsyncLocalStorage<((chunk: string) => void) | undefined>()

/** Runs a computer port call with the tool's live output reachable from the daemon's native layer. */
export function withComputerOutput<T>(context: { onOutput?(chunk: string): void }, call: () => T): T {
  return computerOutput.run(context.onOutput ? (chunk) => context.onOutput!(chunk) : undefined, call)
}
