import type { MessageID, SessionID } from "@/session/schema"

export type ComputerTarget = {
  pid: number
  bundleID: string
  appName: string
  windowName?: string
}

export type ComputerNode = {
  id: string
  role: string
  name: string
  value?: string
  secure?: true
  states: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  actions: string[]
}

export type ComputerObservation = {
  revision: number
  target: ComputerTarget
  nodes: ComputerNode[]
  truncated: boolean
  observedAt: number
}

export type ComputerAuditEntry = {
  action: string
  revision: number
  nodeID?: string
  result: "completed" | "failed"
  at: number
}

export type ComputerSessionState = {
  id: string
  mendcodeSessionID: SessionID
  initiatingMessageID: MessageID
  target: ComputerTarget
  mode: "observe" | "control"
  createdAt: number
  expiresAt: number
  lastActiveAt: number
  revision: number
  status: "active" | "stopped"
  observation?: ComputerObservation
  consumedNodes: Set<string>
  actionInFlight: boolean
  audit: ComputerAuditEntry[]
}
