import { defineTheme } from "./define"
import { withReadableContrast } from "./contrast"

/** Ported from MendCode v1 `context/theme/matrix.json` (dark variant). */
export default withReadableContrast(defineTheme({
  name: "matrix",
  label: "Matrix",
  dark: true,
  background: "#0a0e0a",
  colors: {
    primary: "#2eff6a",
    text: "#62ff94",
    body: "#62ff94",
    muted: "#8ca391",
    border: "#1e2a1b",
    heading: "#00efff",
    code: "#1cc24b",
    link: "#30b3ff",
    success: "#62ff94",
    warning: "#e6ff57",
    error: "#ff4b4b",
    accent: "#c770ff",
    secondary: "#00efff",
    info: "#30b3ff",
    borderActive: "#2eff6a",
    panel: "#0e130d",
    element: "#141c12",
    diffAddedBg: "#132616",
    diffRemovedBg: "#261212",
    synComment: "#8ca391",
    synKeyword: "#c770ff",
    synString: "#1cc24b",
    synNumber: "#ffa83d",
    synFunction: "#30b3ff",
    synType: "#e6ff57",
  },
}))
