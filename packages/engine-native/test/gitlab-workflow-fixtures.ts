import type { Fetch, GitLabSocket, GitLabSocketFactory } from "../src"
import { GITLAB_TOKEN, GITLAB_URL } from "./gitlab-fixtures"

export const workflowCheckpoint = (text: string, status = "RUNNING", id = "agent-1") => ({ newCheckpoint: { status, checkpoint: JSON.stringify({ channel_values: { ui_chat_log: [{ message_type: "agent", message_id: id, content: text }] } }) } })

export class WorkflowPeer implements GitLabSocket {
  readyState: WebSocket["readyState"] = 0
  onopen: WebSocket["onopen"] = null
  onmessage: WebSocket["onmessage"] = null
  onerror: WebSocket["onerror"] = null
  onclose: WebSocket["onclose"] = null
  sent: Record<string, any>[] = []
  constructor(readonly reply: (value: Record<string, any>, peer: WorkflowPeer) => void) {
    queueMicrotask(() => { this.readyState = 1; this.onopen?.call(this as unknown as WebSocket, new Event("open")) })
  }
  send(data: Parameters<WebSocket["send"]>[0]) {
    const value = JSON.parse(String(data))
    this.sent.push(value)
    this.reply(value, this)
  }
  close() { this.readyState = 3 }
  receive(value: unknown) { this.raw(JSON.stringify(value)) }
  raw(text: string) { this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data: text })) }
  drop() { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close", { code: 1006, reason: GITLAB_TOKEN })) }
}

export function workflowFake(reply: (value: Record<string, any>, peer: WorkflowPeer) => void = (value, peer) => { if (value.startRequest) peer.receive(workflowCheckpoint("Done", "COMPLETED")) }) {
  const calls: { url: string; init: RequestInit }[] = []
  const peers: { url: string; headers: Record<string, string>; peer: WorkflowPeer }[] = []
  const fetch: Fetch = async (url, init) => {
    if (!url.startsWith(`${GITLAB_URL}/api/v4/ai/duo_workflows/`)) throw new Error("Unexpected fake workflow route")
    calls.push({ url, init })
    if (url.endsWith("/direct_access")) return Response.json({ duo_workflow_service: { base_url: "https://must-not-contact.example", token: "unused" } })
    if (url.endsWith("/workflows")) return Response.json({ id: calls.filter((call) => call.url.endsWith("/workflows")).length })
    throw new Error("Unexpected fake workflow route")
  }
  const socket: GitLabSocketFactory = (url, headers) => {
    const peer = new WorkflowPeer(reply)
    peers.push({ url, headers, peer })
    return peer
  }
  return { fetch, socket, calls, peers }
}
