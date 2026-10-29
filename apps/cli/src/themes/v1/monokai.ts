import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/monokai.json` (dark variant). */
export default defineTheme({
  name: "monokai",
  label: "Monokai",
  dark: true,
  background: "#272822",
  colors: {
    primary: "#66d9ef",
    text: "#f8f8f2",
    body: "#f8f8f2",
    muted: "#75715e",
    border: "#787770",
    heading: "#f92672",
    code: "#a6e22e",
    link: "#66d9ef",
    success: "#a6e22e",
    warning: "#e6db74",
    error: "#f92672",
    accent: "#a6e22e",
    secondary: "#ae81ff",
    info: "#fd971f",
    borderActive: "#66d9ef",
    panel: "#1e1f1c",
    element: "#3e3d32",
    diffAddedBg: "#1a3a1a",
    diffRemovedBg: "#3a1a1a",
  },
})
