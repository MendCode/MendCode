import { z } from "zod"
import { lazySchema } from "./lazy"

/** Public Vertex routing and ADC policy. Credential files and tokens stay in the daemon. */
export const VertexOptions = lazySchema(() => z.strictObject({
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable().optional(),
  location: z.string().regex(/^(global|[a-z]+(?:-[a-z0-9]+)+)$/).nullable().optional(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  quotaProject: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable().optional(),
  allowMetadata: z.boolean().optional(),
  endpoint: z.string().max(2048).refine((value) => {
    try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) } catch { return false }
  }, "Vertex endpoint requires HTTPS or loopback HTTP").nullable().optional(),
}))
export type VertexOptions = z.infer<typeof VertexOptions>
