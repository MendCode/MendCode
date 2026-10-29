import path from "node:path"
import { writeFileSync } from "node:fs"
import { createDaemonImageGenTool } from "../../../packages/daemon/src/image-generation"
import { runTool, type ToolResult } from "../../../packages/tools/src"
import { appHarness, conversation, ids, tempDir } from "./session-ui-harness"

export const IMAGE_SCENES = ["generated-caption", "generated-no-caption", "edited-caption", "caption-optional-failure", "caption-required-failure", "subscription-failure"] as const
export type ImageScene = typeof IMAGE_SCENES[number]
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

export async function imageSceneResult(scene: ImageScene): Promise<ToolResult> {
  const dir = tempDir("image-parity-data-"), project = tempDir("image-parity-project-")
  const edit = scene === "edited-caption"
  const ref = path.join(project, "reference.png")
  if (edit) writeFileSync(ref, PNG)
  const tool = createDaemonImageGenTool({ dir, env: {}, settings: () => ({ image_generation: { enabled: true, adapter: "codex-oauth", model: "openai:gpt-image-2", caption: { enabled: scene !== "generated-no-caption", model: "chatgpt:vision", required: scene === "caption-required-failure" } } }), subscriptionHeaders: async () => ({ authorization: "Bearer local-fake" }), fetch: async () => scene === "subscription-failure" ? new Response("Image generation not available for this account", { status: 403 }) : new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })), provider: { id: "local-fake", model: "vision", async *stream() {
    if (scene.includes("failure")) throw new Error("Local caption failure")
    yield { type: "text", delta: "A green MendCode icon, centered on a dark background, with crisp white lettering." }
    yield { type: "finish", reason: "stop" }
  } } })!
  const result = await runTool(tool, { prompt: "Create a green MendCode icon", ...(edit ? { referenced_image_paths: [ref] } : {}) }, { cwd: project, signal: new AbortController().signal })
  const normalize = (text: string) => text.replaceAll(dir, "/data/mendcode").replaceAll(project, "/work/project")
  return { ...result, output: normalize(result.output), meta: Object.fromEntries(Object.entries(result.meta ?? {}).map(([key, value]) => [key, typeof value === "string" ? normalize(value) : value])), ...(result.render ? { render: JSON.parse(normalize(JSON.stringify(result.render))) } : {}) }
}

export function drawImageScene(width: number, height: number, scene: ImageScene, result: ToolResult) {
  const h = appHarness({ width, height, mode: "full", dataDir: tempDir(), directory: "/work/project" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn"), itemId = ids("item"), userId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: scene === "edited-caption" ? "Make the icon lettering white." : "Create a green MendCode icon." })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "image_gen" } })
  chat.emit({ type: "item.completed", itemId, status: result.isError ? "error" : "ok", text: result.output, meta: result.meta, ...(result.render ? { render: result.render } : {}) })
  chat.emit({ type: "turn.completed", turnId })
  h.app.render()
  return h
}
