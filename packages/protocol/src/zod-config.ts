import { config } from "zod"

/**
 * Zod checks objects without code generation. By default it compiles a validator with `new Function` for each object schema
 * the first time one parses; a terminal that hosts the daemon held 3 MB more at the prompt that way, with no CPU difference
 * measured while a reply streams (docs/performance.md). Imported first by the protocol and the daemon, so the terminal client that loads neither never loads zod for it.
 */
config({ jitless: true })
