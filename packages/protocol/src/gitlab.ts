import { z } from "zod"
import { lazySchema } from "./lazy"

export const GitLabConfig = lazySchema(() => z.strictObject({
  authType: z.enum(["api", "oauth"]).optional(),
  aiGatewayUrl: z.string().min(1).max(2048).optional(),
  rootNamespaceId: z.string().regex(/^gid:\/\/gitlab\/Group\/[1-9][0-9]*$/).optional(),
  featureFlags: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/), z.boolean()).refine((value) => Object.keys(value).length <= 32).optional(),
  projectId: z.string().regex(/^[1-9][0-9]*$/).max(20).optional(),
}))
export type GitLabConfig = z.infer<typeof GitLabConfig>
