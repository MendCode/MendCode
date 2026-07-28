/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import { onMount } from "solid-js"
import { setupSlots, Slot as RuntimeSlot } from "@/cli/cmd/tui/plugin/slots"

type Slots = {
  prompt: {}
}

test("runtime slot renders fallback before plugins initialize", async () => {
  let mounts = 0

  const Fallback = () => {
    onMount(() => {
      mounts += 1
    })

    return <box />
  }

  await testRender(() => (
    <RuntimeSlot name="home_prompt" mode="replace">
      <Fallback />
    </RuntimeSlot>
  ))

  expect(mounts).toBe(1)
})

test("runtime slot keeps fallback when plugin returns primitive text", async () => {
  let fallbackMounts = 0

  const Fallback = () => {
    onMount(() => {
      fallbackMounts += 1
    })

    return <box />
  }

  const App = () => {
    const renderer = useRenderer()
    const slots = setupSlots({
      renderer,
      theme: {},
    } as any)

    slots.register({
      id: "primitive-plugin",
      slots: {
        home_prompt() {
          return "broken prompt replacement"
        },
      },
    })

    return (
      <RuntimeSlot name="home_prompt" mode="replace">
        <Fallback />
      </RuntimeSlot>
    )
  }

  await testRender(() => <App />)

  expect(fallbackMounts).toBe(1)
})

test("replace slot mounts plugin content once", async () => {
  let mounts = 0

  const Probe = () => {
    onMount(() => {
      mounts += 1
    })

    return <box />
  }

  const App = () => {
    const renderer = useRenderer()
    const reg = createSolidSlotRegistry<Slots>(renderer, {})
    const Slot = createSlot(reg)

    reg.register({
      id: "plugin",
      slots: {
        prompt() {
          return <Probe />
        },
      },
    })

    return (
      <box>
        <Slot name="prompt" mode="replace">
          <box />
        </Slot>
      </box>
    )
  }

  await testRender(() => <App />)

  expect(mounts).toBe(1)
})
