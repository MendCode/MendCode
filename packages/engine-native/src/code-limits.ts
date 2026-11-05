/** Shared by the tool schema and interpreter without loading the interpreter at startup. */
export const CODE_LIMITS = { maxCodeBytes: 32_768, maxToolCalls: 16, maxOutputBytes: 24_576, timeoutMs: 30_000, maxValueBytes: 1_048_576, maxOperations: 500_000, maxAllocatedBytes: 8_388_608 } as const
