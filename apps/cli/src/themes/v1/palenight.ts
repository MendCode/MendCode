import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/palenight.json` (dark variant). */
export default defineTheme({
  name: "palenight",
  label: "Palenight",
  dark: true,
  background: "#292d3e",
  colors: {
    primary: "#82aaff",
    text: "#a6accd",
    body: "#a6accd",
    muted: "#676e95",
    border: "#7a7c89",
    heading: "#c792ea",
    code: "#c3e88d",
    link: "#82aaff",
    success: "#c3e88d",
    warning: "#ffcb6b",
    error: "#f07178",
    accent: "#89ddff",
    secondary: "#c792ea",
    info: "#f78c6c",
    borderActive: "#82aaff",
    panel: "#1e2132",
    element: "#32364a",
    diffAddedBg: "#2e3c2b",
    diffRemovedBg: "#3c2b2b",
  },
})
