import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type SetupStepID = "provider" | "models" | "budget" | "package" | "prompt" | "tui" | "memory" | "permissions"

export type SetupRoute = {
  type: "setup"
  step?: SetupStepID
  minimal?: boolean
  returnTo?: HomeRoute | SessionRoute
}

export type StatsRoute = {
  type: "stats"
  scope?: "global" | "project" | "directory"
  returnTo?: HomeRoute | SessionRoute
}

export type MemoryRoute = {
  type: "memory"
  returnTo?: HomeRoute | SessionRoute
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | SetupRoute | StatsRoute | MemoryRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const [store, setStore] = createStore<Route>(
      props.initialRoute ??
        (process.env["OPENCODE_ROUTE"]
          ? JSON.parse(process.env["OPENCODE_ROUTE"])
          : {
              type: "home",
            }),
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}

export function routeReturnTarget(route: Route): HomeRoute | SessionRoute {
  if ((route.type === "setup" || route.type === "stats" || route.type === "memory") && route.returnTo) return route.returnTo
  return { type: "home" }
}
