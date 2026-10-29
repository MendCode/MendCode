import type { MflowReport } from "@mendcode/protocol"

export function mflowText(report: MflowReport) {
  return [
    `Mflow · ${report.mode}`,
    `Room: ${report.config.room}`,
    `Relay: ${report.config.signaling}`,
    `Priority: ${report.config.hookPriority} · token: ${report.config.tokenConfigured ? "configured" : "not configured"}`,
    report.daemon.output,
    `Peers: ${report.peers.length} · locks: ${report.locks.length}`,
    ...report.peers.map((peer) => `  peer ${peer.owner} · expires ${new Date(peer.expiresAt).toISOString()}`),
    ...report.locks.map((lock) => `  ${lock.mode} ${lock.files.join(", ")} · ${lock.owner} · expires ${new Date(lock.expiresAt).toISOString()}`),
    ...(report.relays ? report.relays.length ? report.relays.map((relay) => `${relay.url} · ${relay.health} · ${relay.peerCount} peers`) : ["No authenticated loopback relay detected"] : []),
    ...(report.guide ? [...report.guide.commands, report.guide.note] : []),
    ...(report.plan ? [`Plan: ${report.planPath}`, "Dry run · no file sync · no daemon start", ...report.plan.commands] : []),
    ...(report.legacy ? [report.legacy.integration, "Legacy live sync: off"] : []),
    ...report.failures, ...report.warnings,
  ].join("\n") + "\n"
}
