import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core"
import type { TuiConfig } from "@/cli/cmd/tui/config/tui"

type ScrollboxPosition = {
  scrollTop: number
  scrollHeight: number
  viewport: { height: number }
}

export class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

export function getScrollAcceleration(tuiConfig?: TuiConfig.Info): ScrollAcceleration {
  if (tuiConfig?.scroll_acceleration?.enabled) {
    return new MacOSScrollAccel()
  }
  if (tuiConfig?.scroll_speed !== undefined) {
    return new CustomSpeedScroll(tuiConfig.scroll_speed)
  }

  return new CustomSpeedScroll(3)
}

export function isScrollboxAtBottom(scroll: ScrollboxPosition, tolerance = 1) {
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
  return scroll.scrollTop >= maxScrollTop - tolerance
}
