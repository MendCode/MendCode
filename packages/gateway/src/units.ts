/**
 * The files `gateway setup` writes: two systemd units and the Caddy site. Plain text from the options, so a re-run
 * compares them byte for byte and rewrites only what changed. Every directive that narrows what a process can do is
 * set unless it would break it; the comments say which ones are left out and why.
 */
export type UnitPaths = { binary: string; stateDir: string; usersRoot: string; runtimeRoot: string; gatewayRuntime: string }
export const GATEWAY_USER = "mendcode-gw"
export const GATEWAY_UNIT = "mendcode-gateway.service"
export const USER_UNIT = "mendcode-user@.service"
export const userUnit = (accountId: string) => `mendcode-user@${accountId}.service`
export const linuxUser = (accountId: string) => `mc-${accountId}`

/** Shared by both units: no new privileges, a read-only system, no devices, kernel or clock access, a private /tmp. */
const SANDBOX = [
  "UMask=0077",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectKernelLogs=yes",
  "ProtectControlGroups=yes",
  "ProtectClock=yes",
  "ProtectHostname=yes",
  "ProtectProc=invisible",
  "RestrictSUIDSGID=yes",
  "RestrictRealtime=yes",
  "LockPersonality=yes",
  "RemoveIPC=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "SystemCallArchitectures=native",
  // MemoryDenyWriteExecute is left out: the JavaScript JIT needs writable code pages.
]

export function gatewayUnit(paths: UnitPaths & { mode: "caddy" | "funnel" }) {
  return `# Written by \`mendcode gateway setup\`; re-run it to change this file.
[Unit]
Description=MendCode gateway (sign-in and routing to per-account daemons)
After=network.target

[Service]
Type=simple
User=${GATEWAY_USER}
Group=${GATEWAY_USER}
# The listening socket's folder: only this service and the edge proxy (group caddy) may enter it.
ExecStartPre=+/usr/bin/install -d -m 2750 -o ${GATEWAY_USER} -g ${paths.mode === "caddy" ? "caddy" : GATEWAY_USER} ${paths.gatewayRuntime}
ExecStart=${paths.binary} gateway run --state ${paths.stateDir}
Restart=on-failure
RestartSec=2
${SANDBOX.join("\n")}
ProcSubset=pid
RestrictNamespaces=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
ReadWritePaths=${paths.stateDir} ${paths.gatewayRuntime} -${paths.runtimeRoot}
InaccessiblePaths=-${paths.usersRoot}
${paths.mode === "caddy"
    ? "# Behind Caddy the gateway speaks only over Unix sockets: no network at all.\nRestrictAddressFamilies=AF_UNIX\nPrivateNetwork=yes\nIPAddressDeny=any"
    : "# Behind Tailscale Funnel it listens on loopback only.\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nIPAddressAllow=localhost\nIPAddressDeny=any"}
MemoryMax=512M
TasksMax=64

[Install]
WantedBy=multi-user.target
`
}

export function userUnitTemplate(paths: UnitPaths & { memoryMax: string; cpuQuota: string; tasksMax: number }) {
  return `# Written by \`mendcode gateway setup\`; re-run it to change this file.
# One instance per gateway account (%i): its own Linux user, home, data, provider keys and agent harness.
[Unit]
Description=MendCode daemon for gateway account %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mc-%i
Group=mc-%i
# The socket folder belongs to the account, with group ${GATEWAY_USER} (setgid) so only the gateway can connect.
ExecStartPre=+/usr/bin/install -d -m 2750 -o mc-%i -g ${GATEWAY_USER} ${paths.runtimeRoot}/%i
ExecStart=${paths.binary} web --no-open --dir ${paths.usersRoot}/%i/data --cwd ${paths.usersRoot}/%i/work --unix-socket ${paths.runtimeRoot}/%i/http.sock
WorkingDirectory=${paths.usersRoot}/%i/work
Environment=HOME=${paths.usersRoot}/%i
Restart=on-failure
RestartSec=5
${SANDBOX.join("\n")}
# Other accounts' homes and the gateway's state are not even visible: an empty folder replaces them.
TemporaryFileSystem=${paths.usersRoot}:ro
BindPaths=${paths.usersRoot}/%i
InaccessiblePaths=-${paths.stateDir}
ReadWritePaths=${paths.usersRoot}/%i -${paths.runtimeRoot}/%i
# Agents need the network (model providers, git) and may sandbox their tools with namespaces, so
# RestrictNamespaces and IP filtering are left out; no account daemon listens on TCP.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
MemoryMax=${paths.memoryMax}
CPUQuota=${paths.cpuQuota}
TasksMax=${paths.tasksMax}

[Install]
WantedBy=multi-user.target
`
}

export const CADDY_SITE_FILE = "/etc/caddy/mendcode-gateway.caddy"
export const CADDYFILE = "/etc/caddy/Caddyfile"
export const CADDY_IMPORT = `import ${CADDY_SITE_FILE}`

/** Caddy obtains and renews a free Let's Encrypt (or ZeroSSL) certificate for the domain by itself; TLS 1.2+ is its default. */
export function caddySite(input: { domain: string; socket: string }) {
  return `# Written by \`mendcode gateway setup\`; re-run it to change this file.
${input.domain} {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
		-Server
	}
	request_body {
		max_size 1MB
	}
	reverse_proxy unix/${input.socket} {
		header_up X-Real-IP {remote_host}
		flush_interval -1
	}
}
`
}
