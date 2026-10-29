import { V1_THEME_ROLES } from "../src/theme-data"

export const themeColors = { primary: "#4ade80", text: "#f3f4f6", body: "#d1d5db", muted: "#9ca3af", border: "#6b7280", heading: "#4ade80", code: "#fbbf24", link: "#60a5fa", success: "#4ade80", warning: "#f59e0b", error: "#ef4444" }
export const nativeTheme = { label: "Forest", background: "#0b1210", colors: themeColors }
export const legacyTheme = {
  defs: { ink: { dark: "#0b1210", light: "#ffffff" }, paper: { dark: "#f3f4f6", light: "#111827" }, green: "#4ade80" },
  theme: { ...Object.fromEntries(V1_THEME_ROLES.map((role) => [role, "green"])), background: "ink", backgroundPanel: "ink", backgroundElement: "ink", text: "paper", markdownText: "paper", syntaxNumber: 214 },
}
