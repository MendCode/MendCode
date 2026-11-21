import { createHash } from "node:crypto"

/** The file name of a project's graph cache: the first 16 hex of the sha1 of its directory. Its own module, so asking whether a project has a cache loads no indexer. */
export const cacheName = (cwd: string): string => `${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`
