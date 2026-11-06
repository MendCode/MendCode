import type { BedrockOptions, VertexOptions } from "@mendcode/protocol"
import { awsHost } from "./aws-signature"
import { outboundEndpoint } from "./endpoint-policy"

/** Catalog validation must not load a provider's streaming adapter. */
export const ANTHROPIC_VERSION = "2023-06-01"
export const geminiUrl = (value: string): URL => outboundEndpoint(value, "Gemini")
export const bedrockRegion = (options: BedrockOptions | undefined, env: Record<string, string | undefined>) => options?.region ?? env.AWS_REGION ?? "us-east-1"
export const bedrockBaseUrl = (region: string) => awsHost("bedrock-runtime", region)

/** Explicit gateways are supported, but plaintext credentials may only travel over HTTP on loopback. */
export function azureBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Azure endpoint must use HTTPS or loopback HTTP, without credentials, query or fragment")
  return url.toString().replace(/\/+$/, "")
}

export function vertexRouting(options: VertexOptions = {}, env: Record<string, string | undefined> = {}) {
  return {
    project: options.project ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT ?? env.GCLOUD_PROJECT,
    location: options.location ?? env.GOOGLE_VERTEX_LOCATION ?? env.GOOGLE_CLOUD_LOCATION ?? env.VERTEX_LOCATION ?? "us-central1",
  }
}

/** Custom endpoints are explicit; HTTP is confined to loopback. No credential-bearing URL or redirect. */
export function vertexEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error()
    return value.replace(/\/+$/, "")
  } catch { throw new Error("[PROVIDER]: Vertex endpoint requires HTTPS or loopback HTTP without credentials, query or fragment") }
}

export function vertexBaseUrl(location: string) {
  if (!/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(location)) throw new Error("[PROVIDER]: invalid Vertex location")
  return `https://${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com/v1`
}

export const isVertexType = (type: string | undefined) => type === "google-vertex" || type === "google-vertex-anthropic"
export const VERTEX_ANTHROPIC_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/

/** v1's Claude routing differs from Gemini: global by default, no GOOGLE_VERTEX_LOCATION alias. */
export function vertexAnthropicRouting(options: VertexOptions = {}, env: Record<string, string | undefined> = {}) {
  return {
    project: options.project ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT ?? env.GCLOUD_PROJECT,
    location: options.location ?? env.GOOGLE_CLOUD_LOCATION ?? env.VERTEX_LOCATION ?? "global",
  }
}
