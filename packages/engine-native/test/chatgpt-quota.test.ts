import { describe, expect, test } from "bun:test"
import { chatgptQuota } from "../src"

describe("ChatGPT quota headers", () => {
  test("maps the weekly primary window and skips an absent secondary window", () => {
    const headers = new Headers({
      "x-codex-plan-type": "pro",
      "x-codex-primary-used-percent": "17",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1791049828",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
    })
    expect(chatgptQuota(headers, 5)).toEqual({
      type: "quota.snapshot",
      provider: "codex",
      plan: "pro",
      windows: [{ id: "primary", label: "7d", usedPercent: 17, windowMinutes: 10_080, resetsAt: 1_791_049_828_000 }],
      status: "allowed",
      fetchedAt: 5,
      source: "chatgpt backend response headers",
    })
  })

  test("5h + 7d plans report both windows; a reached limit is rejected", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "40.5",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-rate-limit-reached-type": "primary",
    })
    const quota = chatgptQuota(headers, 0)!
    expect(quota.windows.map((w) => `${w.label} ${w.usedPercent}`)).toEqual(["5h 100", "7d 40.5"])
    expect(quota.status).toBe("rejected")
  })

  test("responses without quota headers produce no snapshot", () => {
    expect(chatgptQuota(new Headers({ "content-type": "text/event-stream" }), 0)).toBeUndefined()
  })
})
