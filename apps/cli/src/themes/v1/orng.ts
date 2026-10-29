import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/orng.json` (dark variant). */
export default defineTheme({
  name: "orng",
  label: "Orng",
  dark: true,
  background: "#0a0a0a",
  colors: {
    primary: "#ec5b2b",
    text: "#eeeeee",
    body: "#eeeeee",
    muted: "#808080",
    border: "#ec5b2b",
    heading: "#ec5b2b",
    code: "#6ba1e6",
    link: "#ec5b2b",
    success: "#6ba1e6",
    warning: "#ec5b2b",
    error: "#e06c75",
    accent: "#fff7f1",
    secondary: "#ee7948",
    info: "#56b6c2",
    borderActive: "#ee7948",
    panel: "#141414",
    element: "#1e1e1e",
    diffAddedBg: "#1a2a3d",
    diffRemovedBg: "#37222c",
  },
})
