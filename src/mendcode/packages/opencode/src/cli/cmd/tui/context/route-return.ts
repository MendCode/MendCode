export type RouteReturnTarget = { type: "home" } | { type: "session"; sessionID: string; prompt?: unknown }

export function routeReturnTarget(route: { type: string; returnTo?: RouteReturnTarget }): RouteReturnTarget {
  if (
    (route.type === "setup" ||
      route.type === "stats" ||
      route.type === "memory" ||
      route.type === "changes" ||
      route.type === "loops" ||
      route.type === "workflows" ||
      route.type === "session-history") &&
    route.returnTo
  ) {
    return route.returnTo
  }
  return { type: "home" }
}
