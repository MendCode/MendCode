/**
 * The instruction loader lives in `@mendcode/tools` so the system prompt and the `read` tool share one implementation
 * (file precedence, includes, limits, mtime/size invalidation); this module keeps the engine's public names.
 */
export { createInstructionLoader, INSTRUCTION_FILES, INSTRUCTION_OVERRIDE, MAX_INSTRUCTION_CHARS } from "@mendcode/tools"
export type { InstructionOptions } from "@mendcode/tools"
