import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { runMemorySideChat } from "./memory-side-chat"
import { jsonRequest } from "./trace"

const MemorySideChatMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string(),
})

const MemorySideChatPayload = z.object({
  root: z.string().optional(),
  message: z.string().min(1),
  history: z.array(MemorySideChatMessage).default([]),
  context: z.object({
    selectedWorkspaceID: z.string().nullable().optional(),
    selectedGroupID: z.string().nullable().optional(),
    selectedCategoryID: z.string().nullable().optional(),
    pageContext: z.string().nullable().optional(),
  }).optional(),
})

export const MemoryRoutes = lazy(() =>
  new Hono().post(
    "/side-chat",
    describeRoute({
      summary: "Ask memory side chat",
      description: "Runs the Memory page side chat through the instance provider runtime.",
      operationId: "memory.sideChat",
      responses: {
        200: {
          description: "Memory side chat response",
          content: { "application/json": { schema: resolver(z.any()) } },
        },
      },
    }),
    validator("json", MemorySideChatPayload),
    async (c) =>
      jsonRequest("MemoryRoutes.sideChat", c, function* () {
        const payload = c.req.valid("json")
        return yield* runMemorySideChat(payload, Instance.directory)
      }),
  ),
)
