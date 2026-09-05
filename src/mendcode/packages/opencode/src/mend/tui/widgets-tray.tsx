import { onMount, type JSX } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { TuiThemeCurrent } from "@mendcode/plugin/tui"

/** Native horizontal scrolling keeps widget navigation separate from the transcript. */
export function SessionWidgetTray(props: {
  width: number
  contentWidth: number
  height: number
  autoFocus?: boolean
  onAutoFocus?: () => void
  theme: Pick<TuiThemeCurrent, "backgroundElement" | "border">
  children: JSX.Element
}) {
  let tray: ScrollBoxRenderable | undefined
  const overflow = () => props.contentWidth > props.width
  onMount(() => {
    if (!props.autoFocus) return
    tray?.focus()
    props.onAutoFocus?.()
  })

  return (
    <scrollbox
      id="session-widget-tray"
      ref={(value: ScrollBoxRenderable) => {
        tray = value
      }}
      width={props.width}
      height={props.height + (overflow() ? 1 : 0)}
      scrollX
      scrollY={false}
      contentOptions={{ width: props.contentWidth, minWidth: props.contentWidth }}
      horizontalScrollbarOptions={{
        visible: overflow(),
        trackOptions: { backgroundColor: props.theme.backgroundElement, foregroundColor: props.theme.border },
      }}
      verticalScrollbarOptions={{ visible: false }}
    >
      {props.children}
    </scrollbox>
  )
}
