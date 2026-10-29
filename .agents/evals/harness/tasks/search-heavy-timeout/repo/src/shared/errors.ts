/** Builds the error thrown when a call exceeds its limit, e.g. "<label> request timed out after <ms>ms". */
export function timeoutError(label: string, ms: number): Error {
  return new Error(`${label} request timed out after ${ms}ms`)
}
