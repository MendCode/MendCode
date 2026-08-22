/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import {
  SESSION_MESSAGE_MAX_MOUNTED,
  sessionMessageVirtualWindow,
  stickyUserIDFromVirtualWindow,
} from "@/cli/cmd/tui/util/session-virtual-window"

type Row = {
  id: string
  role: "user" | "assistant"
  height: number
}

type Harness = {
  scroll: ScrollBoxRenderable
  setFollow: (value: boolean) => void
  setScrollTop: (value: number) => void
  setViewportHeight: (value: number) => void
  setVirtualAnchorID: (value: string | undefined) => void
  syncScrollTop: () => void
  detachFromScroll: (delta: number) => void
  measureMounted: () => void
  append: (row: Row) => void
  prepend: (rows: Row[]) => void
  mountedIDs: () => string[]
  visibleTranscriptIDs: () => string[]
  viewportLeadingGap: () => number
  stickyID: () => string | undefined
  window: () => ReturnType<typeof sessionMessageVirtualWindow>
}

function rows(count: number) {
  return Array.from(
    { length: count },
    (_, index): Row => ({
      id: `msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      height: index % 37 === 0 ? 4 : 1,
    }),
  )
}

function TranscriptHarness(props: { initial: Row[]; ready: (harness: Harness) => void; exactHeights?: boolean }) {
  const [items, setItems] = createSignal(props.initial)
  const [follow, setFollow] = createSignal(true)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(24)
  const [virtualAnchorID, setVirtualAnchorID] = createSignal<string>()
  const [measuredHeights, setMeasuredHeights] = createSignal(new Map<string, number>())
  let scroll!: ScrollBoxRenderable

  const window = createMemo(() => {
    const current = items()
    const anchor = virtualAnchorID()
    return sessionMessageVirtualWindow({
      total: current.length,
      scrollTop: scrollTop(),
      viewportHeight: viewportHeight(),
      followOutput: follow(),
      anchorIndex: anchor ? current.findIndex((item) => item.id === anchor) : undefined,
      itemHeights:
        props.exactHeights === false
          ? current.map((item) => measuredHeights().get(item.id))
          : current.map((item) => item.height),
    })
  })
  const mounted = createMemo(() => items().slice(window().start, window().end))
  const stickyID = createMemo(() => {
    const current = items()
    const mountedUserAnchors = scroll
      ? scroll
          .getChildren()
          .filter((child) => child.id?.startsWith("msg-") && current[Number(child.id.slice(4))]?.role === "user")
          .map((child) => ({ id: child.id, y: child.y }))
      : []
    return stickyUserIDFromVirtualWindow({
      messages: current,
      window: window(),
      mountedUserAnchors,
      top: scroll?.y ?? 0,
      isUser: (item) => item.role === "user",
    })
  })

  onMount(() => {
    props.ready({
      scroll,
      setFollow,
      setScrollTop,
      setViewportHeight,
      setVirtualAnchorID,
      syncScrollTop: () => setScrollTop(scroll.scrollTop),
      detachFromScroll: (delta) => {
        scroll.scrollBy(delta)
        setScrollTop(scroll.scrollTop)
        setFollow(false)
      },
      measureMounted: () => {
        const next = new Map(measuredHeights())
        for (const child of scroll.getChildren()) {
          if (!child.id?.startsWith("msg-")) continue
          next.set(child.id, child.height)
        }
        setMeasuredHeights(next)
      },
      append: (row) => setItems((current) => [...current, row]),
      prepend: (rows) => setItems((current) => [...rows, ...current]),
      mountedIDs: () => mounted().map((item) => item.id),
      visibleTranscriptIDs: () => {
        const top = scroll.y
        const bottom = top + scroll.viewport.height
        return scroll
          .getChildren()
          .filter((child) => child.id?.startsWith("msg-") && child.y < bottom && child.y + child.height > top)
          .flatMap((child) => (child.id ? [child.id] : []))
      },
      viewportLeadingGap: () => {
        const top = scroll.y
        const first = scroll
          .getChildren()
          .filter((child) => child.id?.startsWith("msg-") && child.y + child.height > top)
          .sort((left, right) => left.y - right.y)[0]
        if (!first) return scroll.viewport.height
        return Math.max(0, first.y - top)
      },
      stickyID,
      window,
    })
  })

  return (
    <box width="100%" height="100%" position="relative">
      <scrollbox
        id="history"
        ref={(value) => (scroll = value)}
        width="100%"
        height="100%"
        stickyScroll={follow()}
        stickyStart="bottom"
        viewportCulling
      >
        <Show when={window().topSpacer > 0}>
          <box id="top-spacer" height={window().topSpacer} flexShrink={0} />
        </Show>
        <For each={mounted()}>
          {(item) => (
            <box id={item.id} height={item.height} flexShrink={0}>
              <text>{item.id}</text>
            </box>
          )}
        </For>
        <Show when={window().bottomSpacer > 0}>
          <box id="bottom-spacer" height={window().bottomSpacer} flexShrink={0} />
        </Show>
      </scrollbox>
      <Show when={stickyID()}>
        {(id) => (
          <box id="sticky-user" position="absolute" top={0} left={0}>
            <text>{id()}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  await Promise.resolve()
  await app.renderOnce()
  await Promise.resolve()
  await app.renderOnce()
}

describe("session transcript headless rendering", () => {
  test("keeps a 10k-message transcript bounded while following and scrolling manually", async () => {
    let harness!: Harness
    const app = await testRender(
      () => <TranscriptHarness initial={rows(10_000)} ready={(value) => (harness = value)} />,
      { width: 100, height: 30 },
    )

    try {
      await settle(app)
      expect(harness.mountedIDs().length).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_MOUNTED)
      expect(harness.mountedIDs().at(-1)).toBe("msg-9999")
      expect(app.captureCharFrame()).toContain("msg-9999")

      harness.setFollow(false)
      harness.setScrollTop(5_000)
      harness.scroll.scrollTo(5_000)
      await settle(app)

      const detached = harness.mountedIDs()
      expect(detached.length).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_MOUNTED)
      expect(detached).not.toContain("msg-9999")
      expect(app.renderer.root.findDescendantById("msg-9999")).toBeUndefined()
      expect(harness.window().topSpacer).toBeGreaterThan(0)
      expect(harness.window().bottomSpacer).toBeGreaterThan(0)
      expect(harness.stickyID()).toMatch(/^msg-\d+$/)
      expect(app.renderer.root.findDescendantById("sticky-user")).toBeDefined()
      expect(app.captureCharFrame()).toContain(harness.stickyID()!)

      const held = detached[Math.floor(detached.length / 2)]!
      harness.setVirtualAnchorID(held)
      harness.append({ id: "msg-10000", role: "user", height: 2 })
      await settle(app)

      expect(harness.mountedIDs()).toContain(held)
      expect(harness.mountedIDs()).not.toContain("msg-10000")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the identity anchor through resize and follows newly appended output at the bottom", async () => {
    let harness!: Harness
    const app = await testRender(
      () => <TranscriptHarness initial={rows(10_000)} ready={(value) => (harness = value)} />,
      { width: 120, height: 36 },
    )

    try {
      await settle(app)
      harness.setFollow(false)
      harness.setScrollTop(8_000)
      harness.scroll.scrollTo(8_000)
      await settle(app)

      const anchor = harness.mountedIDs()[Math.floor(harness.mountedIDs().length / 2)]!
      harness.setVirtualAnchorID(anchor)
      app.resize(62, 20)
      harness.setViewportHeight(14)
      await settle(app)

      expect(harness.mountedIDs()).toContain(anchor)
      expect(harness.mountedIDs().length).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_MOUNTED)

      harness.setVirtualAnchorID(undefined)
      harness.setFollow(true)
      harness.append({ id: "msg-10000", role: "user", height: 2 })
      await settle(app)

      expect(harness.mountedIDs().at(-1)).toBe("msg-10000")
      // The session route schedules this bottom reconciliation after the
      // virtual tail has mounted; OpenTUI cannot scroll to its new height first.
      harness.scroll.scrollTo(harness.scroll.scrollHeight)
      await settle(app)
      expect(app.captureCharFrame()).toContain("msg-10000")
    } finally {
      app.renderer.destroy()
    }
  })

  test("never exposes an empty transcript frame while submitting at the virtual tail", async () => {
    let harness!: Harness
    const app = await testRender(() => <TranscriptHarness initial={rows(300)} ready={(value) => (harness = value)} />, {
      width: 100,
      height: 30,
    })

    try {
      await settle(app)
      harness.scroll.scrollTo(harness.scroll.scrollHeight)
      harness.syncScrollTop()
      await settle(app)

      const submitted = { id: "msg-300", role: "user" as const, height: 3 }
      harness.append(submitted)
      await app.renderOnce()
      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)

      harness.setVirtualAnchorID(submitted.id)
      harness.setFollow(false)
      await app.renderOnce()
      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.mountedIDs()).toContain(submitted.id)

      await settle(app)
      expect(app.captureCharFrame()).toContain(submitted.id)
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not accumulate renderables while traversing a long transcript", async () => {
    let harness!: Harness
    const app = await testRender(
      () => <TranscriptHarness initial={rows(10_000)} ready={(value) => (harness = value)} />,
      { width: 100, height: 30 },
    )

    try {
      await settle(app)
      harness.setFollow(false)
      const previouslyMounted = new Set<string>()

      for (let step = 0; step < 64; step++) {
        const position = 200 + step * 137
        harness.setScrollTop(position)
        harness.scroll.scrollTo(position)
        await settle(app)
        const mounted = harness.mountedIDs()
        mounted.forEach((id) => previouslyMounted.add(id))
        expect(mounted.length).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_MOUNTED)
        expect(harness.scroll.getChildren().filter((child) => child.id?.startsWith("msg-")).length).toBeLessThanOrEqual(
          SESSION_MESSAGE_MAX_MOUNTED,
        )
        expect(harness.stickyID()).toBeDefined()
        expect(app.renderer.root.findDescendantById("sticky-user")).toBeDefined()
      }

      const finalMounted = new Set(harness.mountedIDs())
      const stillLive = [...previouslyMounted].filter((id) => app.renderer.root.findDescendantById(id))
      expect(stillLive.every((id) => finalMounted.has(id))).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps content and sticky user visible while wheel-scrolling up from the virtual tail", async () => {
    let harness!: Harness
    const app = await testRender(() => <TranscriptHarness initial={rows(300)} ready={(value) => (harness = value)} />, {
      width: 100,
      height: 30,
    })

    try {
      await settle(app)
      harness.scroll.scrollTo(harness.scroll.scrollHeight)
      await settle(app)

      for (let step = 0; step < 30; step++) {
        harness.detachFromScroll(-8)
        await settle(app)

        expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
        expect(harness.stickyID()).toBeDefined()
        expect(app.renderer.root.findDescendantById("sticky-user")).toBeDefined()
        expect(harness.viewportLeadingGap()).toBeLessThanOrEqual(1)
        expect(harness.window().topSpacer).toBeLessThanOrEqual(
          harness.scroll.scrollTop + harness.scroll.viewport.height,
        )
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the top edge usable when older rows cross into virtualization", async () => {
    let harness!: Harness
    const initial = Array.from(
      { length: 200 },
      (_, index): Row => ({
        id: `msg-${index + 100}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: 6,
      }),
    )
    const older = Array.from(
      { length: 50 },
      (_, index): Row => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: 6,
      }),
    )
    const app = await testRender(() => <TranscriptHarness initial={initial} ready={(value) => (harness = value)} />, {
      width: 100,
      height: 30,
    })

    try {
      await settle(app)
      harness.setFollow(false)
      harness.setScrollTop(0)
      harness.scroll.scrollTo(0)
      await settle(app)
      harness.setVirtualAnchorID("msg-100")
      harness.prepend(older)
      await settle(app)

      // The paging restore can take several frames. During that interval the
      // physical top must remain populated; mounting only around msg-100
      // leaves a large prefix spacer at scrollTop=0 and renders a blank chat.
      expect(harness.window().topSpacer).toBe(0)
      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.mountedIDs()).toContain("msg-100")

      // Model the route's identity-anchor restore after the new prefix has
      // mounted. The next assertion starts from a real restored viewport.
      harness.setScrollTop(300)
      harness.scroll.scrollTo(300)
      await settle(app)

      expect(harness.window().virtualized).toBe(true)
      expect(harness.mountedIDs()).toContain("msg-100")
      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)

      // Once identity restoration completes, the virtualizer must stop
      // forcing that row and return to the physical scroll position.
      harness.setVirtualAnchorID(undefined)

      // After the first page is restored, walking back to the absolute top
      // must not keep forcing the old paging anchor into the mounted range.
      harness.setScrollTop(0)
      harness.scroll.scrollTo(0)
      await settle(app)

      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.mountedIDs()).toContain("msg-0")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps scrolling down usable after two older pages cross into virtualization", async () => {
    let harness!: Harness
    const initial = Array.from(
      { length: 150 },
      (_, index): Row => ({
        id: `msg-${index + 100}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: 6,
      }),
    )
    const firstOlder = Array.from(
      { length: 50 },
      (_, index): Row => ({
        id: `msg-${index + 50}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: 6,
      }),
    )
    const secondOlder = Array.from(
      { length: 50 },
      (_, index): Row => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: 6,
      }),
    )
    const app = await testRender(() => <TranscriptHarness initial={initial} ready={(value) => (harness = value)} />, {
      width: 100,
      height: 30,
    })

    try {
      await settle(app)
      harness.setFollow(false)
      harness.setScrollTop(0)
      harness.scroll.scrollTo(0)
      await settle(app)

      harness.setVirtualAnchorID("msg-100")
      harness.prepend(firstOlder)
      await settle(app)
      harness.setVirtualAnchorID(undefined)
      harness.setScrollTop(0)
      harness.scroll.scrollTo(0)
      await settle(app)

      harness.setVirtualAnchorID("msg-50")
      harness.prepend(secondOlder)
      await settle(app)
      expect(harness.window().virtualized).toBe(true)
      harness.setVirtualAnchorID(undefined)

      harness.setScrollTop(0)
      harness.scroll.scrollTo(0)
      await settle(app)
      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.mountedIDs()).toContain("msg-0")

      for (const position of [24, 72, 144, 240, 360, 480, 600]) {
        harness.setScrollTop(position)
        harness.scroll.scrollTo(position)
        await settle(app)
        expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
        expect(harness.viewportLeadingGap()).toBeLessThanOrEqual(1)
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not expose virtual spacer gaps while newly mounted tall messages are measured", async () => {
    let harness!: Harness
    const variableRows = Array.from(
      { length: 300 },
      (_, index): Row => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: index % 11 === 0 ? 80 : index % 7 === 0 ? 24 : 2,
      }),
    )
    const app = await testRender(
      () => <TranscriptHarness initial={variableRows} exactHeights={false} ready={(value) => (harness = value)} />,
      { width: 100, height: 30 },
    )

    try {
      await settle(app)
      harness.scroll.scrollTo(harness.scroll.scrollHeight)
      await settle(app)

      for (let step = 0; step < 30; step++) {
        harness.measureMounted()
        harness.syncScrollTop()
        await settle(app)
        harness.detachFromScroll(-12)
        await settle(app)

        expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
        expect(harness.stickyID()).toBeDefined()
        expect(app.renderer.root.findDescendantById("sticky-user")).toBeDefined()
        expect(harness.viewportLeadingGap()).toBeLessThanOrEqual(1)
        expect(harness.window().topSpacer).toBeLessThanOrEqual(
          harness.scroll.scrollTop + harness.scroll.viewport.height,
        )
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test("fills the viewport when tail rows render no visible content", async () => {
    let harness!: Harness
    const sparseRows = Array.from(
      { length: 150 },
      (_, index): Row => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: index >= 45 && index < 145 ? 0 : 1,
      }),
    )
    const app = await testRender(
      () => <TranscriptHarness initial={sparseRows} exactHeights={false} ready={(value) => (harness = value)} />,
      { width: 100, height: 30 },
    )

    try {
      for (let pass = 0; pass < 8; pass++) {
        await settle(app)
        harness.measureMounted()
        harness.syncScrollTop()
      }
      await settle(app)

      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.viewportLeadingGap()).toBeLessThanOrEqual(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps visible rows mounted when a transcript exceeds the cap with a zero-height tail", async () => {
    let harness!: Harness
    const sparseRows = Array.from(
      { length: 220 },
      (_, index): Row => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        height: index >= 70 ? 0 : 1,
      }),
    )
    const app = await testRender(
      () => <TranscriptHarness initial={sparseRows} exactHeights={true} ready={(value) => (harness = value)} />,
      { width: 100, height: 30 },
    )

    try {
      for (let pass = 0; pass < 8; pass++) {
        await settle(app)
        harness.measureMounted()
        harness.syncScrollTop()
      }
      await settle(app)

      expect(harness.visibleTranscriptIDs()).not.toHaveLength(0)
      expect(harness.mountedIDs().at(-1)).toBe("msg-69")
      expect(harness.window().bottomSpacer).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })
})
