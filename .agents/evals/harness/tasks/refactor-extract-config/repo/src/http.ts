export type RequestOptions = { url: string; timeoutMs: number }

export function buildUrl(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`
  return `https://api.example.test/v2${clean}`
}

export function requestOptions(path: string): RequestOptions {
  return { url: buildUrl(path), timeoutMs: 5000 }
}

export type Transport = (url: string, init: { timeoutMs: number }) => Promise<{ status: number; body: unknown }>

export async function getJson(transport: Transport, path: string): Promise<unknown> {
  const options = requestOptions(path)
  const response = await transport(options.url, { timeoutMs: options.timeoutMs })
  if (response.status >= 500) throw new Error(`server error ${response.status}`)
  return response.body
}
