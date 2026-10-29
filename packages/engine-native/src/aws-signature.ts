import { createHash, createHmac } from "node:crypto"

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: number }
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest()
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

/** SigV4 signs the exact body sent; session credentials add a signed security-token header. */
export function signAws(input: { url: string; method: string; body: string; region: string; service: string; credentials: AwsCredentials; headers?: Record<string, string>; now?: Date }): Record<string, string> {
  const url = new URL(input.url)
  const date = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")
  const headers: Record<string, string> = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")]))
  delete headers.authorization
  headers.host = url.host
  headers["x-amz-date"] = date
  headers["x-amz-content-sha256"] = hash(input.body)
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken
  const keys = Object.keys(headers).sort()
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&")
  // Non-S3 services double-encode the already escaped path in the canonical request.
  const uri = url.pathname.split("/").map(encode).join("/") || "/"
  const canonical = [input.method, uri, query, keys.map((key) => `${key}:${headers[key]}\n`).join(""), keys.join(";"), hash(input.body)].join("\n")
  const scope = `${date.slice(0, 8)}/${input.region}/${input.service}/aws4_request`
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date.slice(0, 8)), input.region), input.service), "aws4_request")
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${keys.join(";")}, Signature=${hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex")}`
  return headers
}

export function awsEndpoint(base: string): string {
  let url: URL
  try { url = new URL(base) } catch { throw new Error("[PROVIDER]: invalid AWS endpoint") }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("[PROVIDER]: AWS endpoint requires HTTPS or loopback HTTP without credentials, query or fragment")
  return url.href.replace(/\/+$/, "")
}

export const awsHost = (service: string, region: string) => `https://${service}.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`
