import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useRoute } from "@tui/context/route"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  flat?: boolean
  variant?: "default" | "command"
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  preview?: (option: DialogSelectOption<T>) => JSX.Element
  skipFilter?: boolean
  renderFilter?: boolean
  keybind?: {
    keybind?: Keybind.Info
    title: string
    side?: "left" | "right"
    disabled?: boolean
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  current?: T
  selectCurrent?: boolean
}

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: string
  footer?: JSX.Element | string
  category?: string
  categoryView?: JSX.Element
  searchText?: string
  disabled?: boolean
  bg?: RGBA
  gutter?: () => JSX.Element
  margin?: JSX.Element
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const route = useRoute()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    activeCategory: undefined as string | undefined,
    input: "keyboard" as "keyboard" | "mouse",
  })

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current && props.selectCurrent !== false) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
          }
        }
      },
    ),
  )

  let input: InputRenderable
  const commandVariant = createMemo(() => props.variant === "command")

  const filtered = createMemo(() => {
    if (props.skipFilter || props.renderFilter === false) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    // Users usually search by item name, then slash aliases, category, or secondary copy.
    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category", "description", "searchText"],
        scoreFn: (r) =>
          (r[0]?.score ?? -100000) * 3 + (r[1]?.score ?? -100000) + (r[2]?.score ?? -100000) + (r[3]?.score ?? -100000),
      })
      .map((x) => x.obj)

    return result
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
  })

  const flatten = createMemo(() => props.flat && store.filter.length > 0)

  const allGrouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (flatten()) return [["", filtered()]]
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })
  const categories = createMemo(() =>
    allGrouped()
      .map(([category]) => category)
      .filter(Boolean),
  )
  const grouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (!commandVariant() || flatten()) return allGrouped()
    const active = store.activeCategory ?? categories()[0]
    const group = allGrouped().find(([category]) => category === active)
    return group ? [group] : allGrouped().slice(0, 1)
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  createEffect(() => {
    if (!commandVariant() || flatten()) return
    const available = categories()
    if (!available.length) return
    if (store.activeCategory && available.includes(store.activeCategory)) return
    setStore("activeCategory", available[0])
    setStore("selected", 0)
  })

  const rows = createMemo(() => {
    if (commandVariant() && !flatten()) return flat().length
    const headers = grouped().reduce((acc, [category], i) => {
      if (!category) return acc
      return acc + (i > 0 ? 2 : 1)
    }, 0)
    return flat().length + headers
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => {
    const reservedRows = props.preview ? 14 : 6
    if (commandVariant()) return Math.min(rows(), Math.max(6, Math.floor(dimensions().height * 0.45)))
    return Math.min(rows(), Math.max(3, Math.floor(dimensions().height / 2) - reservedRows))
  })

  const selected = createMemo(() => flat()[store.selected])

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true)
        } else if (current && props.selectCurrent !== false) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next, true)
  }

  function moveCategory(direction: number) {
    const available = categories()
    if (!available.length) return
    const current = store.activeCategory ?? available[0]
    const index = Math.max(0, available.indexOf(current))
    const next = (index + direction + available.length) % available.length
    batch(() => {
      setStore("activeCategory", available[next])
      setStore("selected", 0)
    })
    scroll?.scrollTo(0)
  }

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    const option = selected()
    if (option) props.onMove?.(option)
    if (!scroll) return
    const target = scroll.getChildren().find((child) => {
      return child.id === JSON.stringify(selected()?.value)
    })
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        if (isDeepEqual(flat()[0].value, selected()?.value)) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  const keybind = useKeybind()
  useKeyboard((evt) => {
    setStore("input", "keyboard")
    const allowCtrlNavigation = route.data.type !== "setup"

    if (evt.name === "up" || (allowCtrlNavigation && evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (allowCtrlNavigation && evt.ctrl && evt.name === "n")) move(1)
    if (commandVariant() && !store.filter && evt.name === "left") {
      evt.preventDefault()
      moveCategory(-1)
    }
    if (commandVariant() && !store.filter && evt.name === "right") {
      evt.preventDefault()
      moveCategory(1)
    }
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") moveTo(0)
    if (evt.name === "end") moveTo(flat().length - 1)

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }

    for (const item of props.keybind ?? []) {
      if (item.disabled || !item.keybind) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        if (s) {
          evt.preventDefault()
          item.onTrigger(s)
        }
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled && x.keybind) ?? [])
  const left = createMemo(() => keybinds().filter((item) => item.side !== "right"))
  const right = createMemo(() => keybinds().filter((item) => item.side === "right"))

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={commandVariant() ? 3 : 4} paddingRight={commandVariant() ? 3 : 4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <Show when={props.renderFilter !== false}>
          <box paddingTop={1}>
            <input
              onInput={(e) => {
                batch(() => {
                  setStore("filter", e)
                  props.onFilter?.(e)
                })
              }}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
              focusedTextColor={theme.textMuted}
              ref={(r) => {
                input = r
                input.traits = { status: "FILTER" }
                setTimeout(() => {
                  if (!input) return
                  if (input.isDestroyed) return
                  input.focus()
                }, 1)
              }}
              placeholder={props.placeholder ?? (commandVariant() ? "search commands, /slash, shortcut..." : "Search")}
              placeholderColor={theme.textMuted}
            />
          </box>
        </Show>
      </box>
      <Show when={commandVariant() && !flatten() && categories().length > 1}>
        <box paddingLeft={3} paddingRight={3} flexDirection="row" gap={2}>
          <For each={categories()}>
            {(category) => {
              const active = createMemo(() => (store.activeCategory ?? categories()[0]) === category)
              return (
                <text
                  fg={active() ? theme.text : theme.textMuted}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  onMouseUp={() => {
                    batch(() => {
                      setStore("activeCategory", category)
                      setStore("selected", 0)
                    })
                    scroll?.scrollTo(0)
                  }}
                >
                  {category}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.textMuted}>No results found</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={commandVariant() ? 1 : 1}
          paddingRight={commandVariant() ? 1 : 1}
          scrollbarOptions={{ visible: false }}
          scrollAcceleration={scrollAcceleration()}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category && (!commandVariant() || flatten())}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <Show
                      when={options[0]?.categoryView}
                      fallback={
                        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                          {category}
                        </text>
                      }
                    >
                      {options[0]?.categoryView}
                    </Show>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => isDeepEqual(option.value, selected()?.value))
                    const current = createMemo(() => isDeepEqual(option.value, props.current))
                    return (
                      <box
                        id={JSON.stringify(option.value)}
                        flexDirection="row"
                        position="relative"
                        onMouseMove={() => {
                          setStore("input", "mouse")
                        }}
                        onMouseUp={() => {
                          option.onSelect?.(dialog)
                          props.onSelect?.(option)
                        }}
                        onMouseOver={() => {
                          if (store.input !== "mouse") return
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        onMouseDown={() => {
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        backgroundColor={active() ? (option.bg ?? theme.primary) : RGBA.fromInts(0, 0, 0, 0)}
                        paddingLeft={current() || option.gutter ? 1 : 3}
                        paddingRight={3}
                        paddingTop={0}
                        paddingBottom={0}
                        gap={1}
                      >
                        <Show when={!current() && option.margin}>
                          <box position="absolute" left={1} flexShrink={0}>
                            {option.margin}
                          </box>
                        </Show>
                        <Option
                          title={option.title}
                          footer={flatten() && !commandVariant() ? (option.category ?? option.footer) : option.footer}
                          description={
                            commandVariant()
                              ? undefined
                              : option.description !== category
                                ? option.description
                                : undefined
                          }
                          active={active()}
                          current={current()}
                          gutter={option.gutter}
                          commandVariant={commandVariant()}
                        />
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.preview && selected()}>
        {(option) => (
          <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column">
            {props.preview?.(option())}
          </box>
        )}
      </Show>
      <Show when={keybinds().length} fallback={<box flexShrink={0} />}>
        <box
          paddingRight={2}
          paddingLeft={4}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
          paddingTop={1}
        >
          <box flexDirection="row" gap={2}>
            <For each={left()}>
              {(item) => (
                <text>
                  <span style={{ fg: theme.text }}>
                    <b>{item.title}</b>{" "}
                  </span>
                  <span style={{ fg: theme.textMuted }}>{Keybind.toString(item.keybind)}</span>
                </text>
              )}
            </For>
          </box>
          <box flexDirection="row" gap={2}>
            <For each={right()}>
              {(item) => (
                <text>
                  <span style={{ fg: theme.text }}>
                    <b>{item.title}</b>{" "}
                  </span>
                  <span style={{ fg: theme.textMuted }}>{Keybind.toString(item.keybind)}</span>
                </text>
              )}
            </For>
          </box>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  description?: string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: () => JSX.Element
  commandVariant?: boolean
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()
  const fg = selectedForeground(theme)

  return (
    <>
      <Show when={props.current}>
        <text flexShrink={0} fg={props.active ? fg : props.current ? theme.primary : theme.text} marginRight={0}>
          ●
        </text>
      </Show>
      <Show when={props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter?.()}
        </box>
      </Show>
      <text
        flexGrow={1}
        fg={props.active ? fg : props.current ? theme.primary : theme.text}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={props.commandVariant ? 1 : 3}
      >
        {Locale.truncate(props.title, props.commandVariant ? 48 : 61)}
        <Show when={props.description}>
          <span style={{ fg: props.active ? fg : theme.textMuted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active ? fg : theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
