import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/dracula.json` (dark variant). */
export default defineTheme({
  name: "dracula",
  label: "Dracula",
  dark: true,
  background: "#282a36",
  colors: {
    primary: "#bd93f9",
    text: "#f8f8f2",
    body: "#f8f8f2",
    muted: "#6272a4",
    border: "#737583",
    heading: "#bd93f9",
    code: "#50fa7b",
    link: "#8be9fd",
    success: "#50fa7b",
    warning: "#f1fa8c",
    error: "#ff5555",
    accent: "#8be9fd",
    secondary: "#ff79c6",
    info: "#ffb86c",
    borderActive: "#bd93f9",
    panel: "#21222c",
    element: "#44475a",
    diffAddedBg: "#1a3a1a",
    diffRemovedBg: "#3a1a1a",
  },
})
