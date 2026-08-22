/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { reasoningViewportHeight } from "../../../src/mend/tui/presentation"

test("short reasoning scrollboxes size to their content instead of the max viewport", async () => {
  const syntaxStyle = SyntaxStyle.create()
  let scrollbox: ScrollBoxRenderable | undefined
  const app = await testRender(
    () => (
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scrollbox = value)}
        height={reasoningViewportHeight("short", 14)}
        maxHeight={14}
        minHeight={1}
        stickyScroll={false}
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={false}
          syntaxStyle={syntaxStyle}
          content="short"
        />
      </scrollbox>
    ),
    { width: 80, height: 30 },
  )

  try {
    await Bun.sleep(20)
    await app.renderOnce()
    expect(scrollbox).toBeDefined()
    expect(scrollbox!.height).toBeGreaterThan(0)
    expect(scrollbox!.height).toBeLessThan(14)
  } finally {
    app.renderer.destroy()
    syntaxStyle.destroy()
  }
})
