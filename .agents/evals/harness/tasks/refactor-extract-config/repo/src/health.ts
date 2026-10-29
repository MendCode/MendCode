export type HealthProbe = { url: string; timeoutMs: number }

/** The uptime monitor pings the API root with the same timeout as real requests. */
export function healthProbe(): HealthProbe {
  return { url: "https://api.example.test/v2/health", timeoutMs: 5000 }
}

export function isHealthy(status: number): boolean {
  return status >= 200 && status < 300
}
