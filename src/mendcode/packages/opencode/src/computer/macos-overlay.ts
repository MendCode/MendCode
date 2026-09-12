const OVERLAY_SCRIPT = String.raw`
ObjC.import("Cocoa")
ObjC.import("QuartzCore")

const peach = $.NSColor.colorWithSRGBRedGreenBlueAlpha(250 / 255, 178 / 255, 131 / 255, 0.95)
const background = $.NSColor.colorWithSRGBRedGreenBlueAlpha(10 / 255, 10 / 255, 10 / 255, 0.92)
const textColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(238 / 255, 238 / 255, 238 / 255, 1)
const point = $.NSEvent.mouseLocation
const frame = $.NSMakeRect(point.x - 24, point.y - 30, 58, 58)
const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  frame,
  $.NSWindowStyleMaskBorderless,
  $.NSBackingStoreBuffered,
  false,
)
window.opaque = false
window.backgroundColor = $.NSColor.clearColor
window.hasShadow = false
window.ignoresMouseEvents = true
window.level = $.NSStatusWindowLevel
window.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary | $.NSWindowCollectionBehaviorStationary

const view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 58, 58))
view.wantsLayer = true
window.contentView = view

const ring = $.CAShapeLayer.layer
ring.frame = $.CGRectMake(8, 14, 30, 30)
ring.path = $.CGPathCreateWithEllipseInRect($.CGRectMake(1, 1, 28, 28), null)
ring.fillColor = $.NSColor.clearColor.CGColor
ring.strokeColor = peach.CGColor
ring.lineWidth = 2
view.layer.addSublayer(ring)

const badge = $.CALayer.layer
badge.frame = $.CGRectMake(36, 4, 14, 14)
badge.backgroundColor = background.CGColor
badge.borderColor = peach.CGColor
badge.borderWidth = 1
badge.cornerRadius = 4
view.layer.addSublayer(badge)

const label = $.CATextLayer.layer
label.frame = $.CGRectMake(36, 3, 14, 14)
label.string = "M"
label.foregroundColor = textColor.CGColor
label.alignmentMode = "center"
label.fontSize = 10
label.contentsScale = $.NSScreen.mainScreen.backingScaleFactor
view.layer.addSublayer(label)

window.orderFrontRegardless
const ready = $("READY\\n").dataUsingEncoding($.NSUTF8StringEncoding)
$.NSFileHandle.fileHandleWithStandardOutput.writeData(ready)
$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(5))
window.orderOut(null)
`

let visibleActions = 0

export function assertComputerCaptureSafe() {
  if (visibleActions > 0) throw new Error("Computer capture is blocked while the user-visible action indicator is active.")
}

async function waitForReady(child: ReturnType<typeof Bun.spawn>, signal: AbortSignal) {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Computer indicator output is unavailable.")
  const reader = child.stdout.getReader()
  const timeout = AbortSignal.timeout(500)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        combined.addEventListener("abort", () => reject(new Error("Computer indicator did not become ready.")), {
          once: true,
        }),
      ),
    ])
    const text = new TextDecoder().decode(result.value)
    if (!text.includes("READY")) throw new Error("Computer indicator did not acknowledge readiness.")
  } finally {
    reader.releaseLock()
  }
}

export async function withVisibleComputerAction<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (process.platform !== "darwin") throw new Error("The MendCode computer indicator is currently supported only on macOS.")
  if (visibleActions > 0) throw new Error("Another visible Computer Use action is already running.")
  const child = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", OVERLAY_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stop = () => child.kill()
  signal.addEventListener("abort", stop, { once: true })
  visibleActions += 1
  try {
    await waitForReady(child, signal)
    signal.throwIfAborted()
    const result = await action()
    await Bun.sleep(160)
    return result
  } finally {
    visibleActions = Math.max(0, visibleActions - 1)
    stop()
    signal.removeEventListener("abort", stop)
    await child.exited.catch(() => undefined)
  }
}
