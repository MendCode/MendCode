import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

const MemorySideChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.String,
})

const MemorySideChatContext = Schema.Struct({
  selectedWorkspaceID: Schema.optional(Schema.NullOr(Schema.String)),
  selectedGroupID: Schema.optional(Schema.NullOr(Schema.String)),
  selectedCategoryID: Schema.optional(Schema.NullOr(Schema.String)),
  pageContext: Schema.optional(Schema.NullOr(Schema.String)),
})

export const MemorySideChatPayload = Schema.Struct({
  root: Schema.optional(Schema.String),
  message: Schema.String,
  history: Schema.optional(Schema.Array(MemorySideChatMessage)),
  context: Schema.optional(MemorySideChatContext),
})

const MemorySideChatAction = Schema.Struct({
  kind: Schema.Literals([
    "propose-memory",
    "propose-policy",
    "explain-state",
    "dream-dry-run",
    "create-memory",
    "edit-memory",
    "delete-memory",
    "move-memory",
    "create-category",
    "edit-category",
    "delete-category",
  ]),
  text: Schema.String,
  categoryIDs: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["project", "global"])),
  targetID: Schema.optional(Schema.String),
  targetScope: Schema.optional(Schema.Literals(["project", "global"])),
  categoryID: Schema.optional(Schema.String),
})

export const MemorySideChatResponse = Schema.Struct({
  text: Schema.String,
  actions: Schema.Array(MemorySideChatAction),
})

export const MemoryPaths = {
  sideChat: `${root}/side-chat`,
} as const

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.post("sideChat", MemoryPaths.sideChat, {
          payload: MemorySideChatPayload,
          success: described(MemorySideChatResponse, "Memory side chat response"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.sideChat",
            summary: "Ask memory side chat",
            description: "Run the Memory page side chat through the instance provider runtime.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "memory", description: "Memory manager routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MendCode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
