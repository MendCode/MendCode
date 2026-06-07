import type { MiddlewareHandler } from "hono"
import { WithInstance } from "@/project/with-instance"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { HEADER_DIRECTORY, HEADER_DIRECTORY_LEGACY } from "@/server/shared/header-names"

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.query("directory") || c.req.header(HEADER_DIRECTORY) || c.req.header(HEADER_DIRECTORY_LEGACY) || process.cwd()
    const directory = AppFileSystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    return WorkspaceContext.provide({
      workspaceID,
      async fn() {
        return WithInstance.provide({
          directory,
          async fn() {
            return next()
          },
        })
      },
    })
  }
}
