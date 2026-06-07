import HomeFooter from "../feature-plugins/home/footer"
import HomeTips from "../feature-plugins/home/tips"
import PluginManager from "../feature-plugins/system/plugins"
import SessionV2Debug from "../feature-plugins/system/session-v2"
import type { TuiPlugin, TuiPluginModule } from "@mendcode/plugin/tui"
import { Flag } from "@mendcode/core/flag/flag"

export type InternalTuiPlugin = TuiPluginModule & {
  id: string
  tui: TuiPlugin
}

export const INTERNAL_TUI_PLUGINS: InternalTuiPlugin[] = [
  HomeFooter,
  HomeTips,
  PluginManager,
  ...(Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM ? [SessionV2Debug] : []),
]
