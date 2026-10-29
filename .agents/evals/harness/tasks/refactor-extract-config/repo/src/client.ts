import { getJson, type Transport } from "./http"
import { retry, type Sleep } from "./retry"

export type ClientOptions = { transport: Transport; sleep?: Sleep }

/** JSON client for the public API: every read is retried on failure. */
export function createClient({ transport, sleep }: ClientOptions) {
  return {
    get: (path: string) => retry(() => getJson(transport, path), { retries: 3, delayMs: 250, ...(sleep ? { sleep } : {}) }),
    describe: () => ({ base: "https://api.example.test/v2", timeoutMs: 5000, retries: 3 }),
  }
}
