import { createStore, reconcile } from "solid-js/store"
import type { SetupStepID } from "@/mend/setup/state"
export type { SetupStepID } from "@/mend/setup/state"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"
import { routeReturnTarget as routeReturnTargetBase } from "./route-return"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

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

export type ChangesRoute = {
  type: "changes"
  returnTo?: HomeRoute | SessionRoute
}

export type LoopsRoute = {
  type: "loops"
  selectedID?: string
  returnTo?: HomeRoute | SessionRoute
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route =
  | HomeRoute
  | SessionRoute
  | SetupRoute
  | StatsRoute
  | MemoryRoute
  | ChangesRoute
  | LoopsRoute
  | PluginRoute

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
  return routeReturnTargetBase(route) as HomeRoute | SessionRoute
}
