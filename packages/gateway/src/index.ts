/** Domain mode (docs/gateway.md): loaded only by `mendcode gateway …`, never by the terminal or the daemon. */
export { createGateway, type Gateway, type GatewayOptions, ACCESS_TOKEN_PREFIX, SESSION_COOKIE, TTL } from "./server"
export { runGatewayCli, GATEWAY_USAGE } from "./cli"
export { deviceSignedText, DEVICE_SIGNATURE_CONTEXT } from "./device-key"
export { parseGatewayConfig, readGatewayConfig, type GatewayConfig } from "./config"
