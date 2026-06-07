import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mendcode/plugin/tui"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Global } from "@mendcode/core/global"
import { useMendTuiProfile } from "@tui/context/mend"
import { useLocal } from "@tui/context/local"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dir = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const branch = props.api.state.vcs?.branch
    if (branch) return out + ":" + branch
    return out
  })

  return <text fg={theme().textMuted}>{dir()}</text>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>runtime {props.api.app.version}</text>
    </box>
  )
}

function MendFooterWidgets(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const mend = useMendTuiProfile()
  const local = useLocal()
  const provider = createMemo(() => {
    const current = local.model.current()
    if (current?.providerID) return current.providerID
    const parsed = local.model.parsed().provider
    return parsed === "Connect a provider" ? "none" : parsed
  })
  const model = createMemo(() => local.model.current()?.modelID || null)
  const valueFor = (item: { id: string; value?: string }) => {
    if (item.id === "models") return model() ? `${provider()}/${model()}` : provider()
    if (item.id === "prompt-mode") return mend.promptMode
    return item.value || "configured"
  }
  const widgets = createMemo(() =>
    mend.profile.widgets.order
      .filter((id) => mend.profile.widgets.enabled.includes(id))
      .filter((id) => mend.profile.widgets.config[id]?.surface === "footer")
      .map((id) => ({ id, ...mend.profile.widgets.config[id] })),
  )

  return (
    <For each={widgets()}>
      {(item) => (
        <text fg={theme().textMuted}>
          <span style={{ fg: mend.profile.theme.tokens.accent }}>{item.label || item.id}</span>{" "}
          {valueFor(item)}
        </text>
      )}
    </For>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <MendFooterWidgets api={props.api} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
