import { UsageWeatherReading, type UsageWeatherReport } from "@mendcode/protocol"

export type UsageWeatherService = (input: { region: string; signal: AbortSignal }) => Promise<unknown>

/** No built-in network service. A host may explicitly supply an adapter; tests supply local fakes. */
export function createUsageWeather(service?: UsageWeatherService, now = Date.now, timeoutMs = 2_000) {
  const cache = new Map<string, { at: number; reading: UsageWeatherReading }>()
  const pending = new Map<string, Promise<UsageWeatherReport>>()

  async function read(region: string): Promise<UsageWeatherReport> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("weather timeout")) }, timeoutMs)
      })
      const reading = UsageWeatherReading.parse(await Promise.race([Promise.resolve().then(() => service!({ region, signal: controller.signal })), timeout]))
      if (cache.size >= 16 && !cache.has(region)) cache.delete(cache.keys().next().value!)
      cache.set(region, { at: now(), reading })
      return { status: "ready", region, reading }
    } catch {
      // Adapter errors may contain URLs, tokens or response bodies. Keep them off the wire and terminal.
      return { status: "error", region }
    } finally {
      if (timer) clearTimeout(timer)
      pending.delete(region)
    }
  }

  return async (input: { enabled?: boolean | undefined; region?: string | undefined }): Promise<UsageWeatherReport> => {
    const region = input.region?.trim()
    if (!input.enabled || !region) return { status: "off" }
    if (!service) return { status: "unavailable", region }
    const saved = cache.get(region)
    if (saved && now() - saved.at < 300_000) return { status: "ready", region, reading: saved.reading }
    const running = pending.get(region)
    if (running) return running
    if (pending.size >= 16) return { status: "error", region }
    const result = read(region)
    pending.set(region, result)
    return result
  }
}
