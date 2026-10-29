import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/catppuccin.json` (dark variant). */
export default defineTheme({
  name: "catppuccin",
  label: "Catppuccin",
  dark: true,
  background: "#1e1e2e",
  colors: {
    primary: "#89b4fa",
    text: "#cdd6f4",
    body: "#cdd6f4",
    muted: "#9399b2",
    border: "#6f707c",
    heading: "#cba6f7",
    code: "#a6e3a1",
    link: "#89b4fa",
    success: "#a6e3a1",
    warning: "#f9e2af",
    error: "#f38ba8",
    accent: "#f5c2e7",
    secondary: "#cba6f7",
    info: "#94e2d5",
    borderActive: "#868794",
    panel: "#181825",
    element: "#11111b",
    diffAddedBg: "#24312b",
    diffRemovedBg: "#3c2a32",
  },
})
