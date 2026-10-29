import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "../apps/cli/test/session-ui-harness"
import type { Loop } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { LOGO_FONTS } from "../apps/cli/src/view/logo-fonts"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { SETUP_ROWS } from "../apps/cli/src/view/setup-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

// bun scripts/render-frames.ts <directory> [100x30 180x50 ...]
const b63 = process.argv.includes("--b63")
const b08 = process.argv.includes("--b08")
const b31 = process.argv.includes("--b31")
const b32 = process.argv.includes("--b32")
const b06b07 = process.argv.includes("--b06-b07")
const b15 = process.argv.includes("--b15")
const parity = process.argv.includes("--b01-b02")
const b04b03 = process.argv.includes("--b04-b03")
const ui7 = process.argv.includes("--ui-7")
const ui5 = process.argv.includes("--ui-5")
const ui4 = process.argv.includes("--ui-4")
const ui3 = process.argv.includes("--ui-3")
const b09 = process.argv.includes("--b09")
const b50 = process.argv.includes("--b50")
const b54 = process.argv.includes("--b54")
const b19 = process.argv.includes("--b19")
const b57 = process.argv.includes("--b57")
const b56 = process.argv.includes("--b56")
const b53 = process.argv.includes("--b53")
const b41 = process.argv.includes("--b41")
const b05 = process.argv.includes("--b05")
const b60 = process.argv.includes("--b60")
const b59 = process.argv.includes("--b59")
const b33 = process.argv.includes("--b33")
const b16 = process.argv.includes("--b16")
const b18 = process.argv.includes("--b18")
const b17 = process.argv.includes("--b17")
const b11 = process.argv.includes("--b11")
const b12 = process.argv.includes("--b12")
const b13 = process.argv.includes("--b13")
const b14 = process.argv.includes("--b14")
const b65 = process.argv.includes("--b65")
const b66 = process.argv.includes("--b66")
const b20 = process.argv.includes("--b20")
const b36 = process.argv.includes("--b36")
const b28 = process.argv.includes("--b28")
const b62 = process.argv.includes("--b62")
const b22 = process.argv.includes("--b22")
const b42 = process.argv.includes("--b42")
const b43 = process.argv.includes("--b43")
const b47 = process.argv.includes("--b47")
const b51 = process.argv.includes("--b51")
const b27 = process.argv.includes("--b27")
const b30 = process.argv.includes("--b30")
const b55 = process.argv.includes("--b55")
const b76 = process.argv.includes("--b76")
const b21 = process.argv.includes("--b21")
const b45 = process.argv.includes("--b45")
const b78 = process.argv.includes("--b78")
const b44 = process.argv.includes("--b44")
const b69 = process.argv.includes("--b69")
const b46 = process.argv.includes("--b46")
const b23 = process.argv.includes("--b23")
const b49 = process.argv.includes("--b49")
const b24 = process.argv.includes("--b24")
const b26 = process.argv.includes("--b26")
const b71 = process.argv.includes("--b71")
const b87 = process.argv.includes("--b87")
const b37 = process.argv.includes("--b37")
const b75 = process.argv.includes("--b75")
const b38 = process.argv.includes("--b38")
const b34 = process.argv.includes("--b34")
const b82 = process.argv.includes("--b82")
const b10 = process.argv.includes("--b10")
const b1003 = process.argv.includes("--b10-03")
const b1014 = process.argv.includes("--b10-14")
const b61 = process.argv.includes("--b61")
const b70 = process.argv.includes("--b70")
const b25 = process.argv.includes("--b25")
const b40 = process.argv.includes("--b40")
const b68 = process.argv.includes("--b68")
const b39 = process.argv.includes("--b39")
const b52 = process.argv.includes("--b52")
const b67 = process.argv.includes("--b67")
const b77 = process.argv.includes("--b77")
const b72 = process.argv.includes("--b72")
const b501 = process.argv.includes("--b50-1")
const b48 = process.argv.includes("--b48")
const b79 = process.argv.includes("--b79")
const b29 = process.argv.includes("--b29")
const b73 = process.argv.includes("--b73")
const b74 = process.argv.includes("--b74")
const b83 = process.argv.includes("--b83")
const b84 = process.argv.includes("--b84")
const b85 = process.argv.includes("--b85")
const b86 = process.argv.includes("--b86")
const b88 = process.argv.includes("--b88")
const b35 = process.argv.includes("--b35")
const b89 = process.argv.includes("--b89")
if (b35) process.argv.splice(process.argv.indexOf("--b35"), 1)
if (b86) process.argv.splice(process.argv.indexOf("--b86"), 1)
if (b88) process.argv.splice(process.argv.indexOf("--b88"), 1)
const b1002 = process.argv.includes("--b10-02")
const b1001 = process.argv.includes("--b10-01")
const b1004 = process.argv.includes("--b10-04")
const b1012 = process.argv.includes("--b10-12")
const b1013 = process.argv.includes("--b10-13")
const b1015 = process.argv.includes("--b10-15")
const b1016 = process.argv.includes("--b10-16")
const b1017 = process.argv.includes("--b10-17")
const b1018 = process.argv.includes("--b10-18")
const b1019 = process.argv.includes("--b10-19")
const b1020 = process.argv.includes("--b10-20")
const b1011 = process.argv.includes("--b10-11")
const b741 = process.argv.includes("--b74-1")
if (b741) process.argv.splice(process.argv.indexOf("--b74-1"), 1)
const b1021 = process.argv.includes("--b10-21")
const b1022 = process.argv.includes("--b10-22")
const [directory, ...sizes] = process.argv.slice(2).filter((arg) => !["--b11", "--b12", "--b13", "--b14", "--b65", "--b66", "--b20", "--b36", "--b28", "--b62", "--b22", "--b42", "--b43", "--b47", "--b51", "--b27", "--b30", "--b55", "--b76", "--b21", "--b45", "--b78", "--b44", "--b69", "--b46", "--b23", "--b49", "--b24", "--b63", "--b08", "--b06-b07", "--b04-b03", "--b01-b02", "--ui-3", "--ui-4", "--ui-5", "--ui-7", "--b09", "--b50", "--b54", "--b19", "--b57", "--b56", "--b53", "--b41", "--b05", "--b60", "--b59", "--b31", "--b32", "--b33", "--b15", "--b16", "--b18", "--b17", "--b64", "--b26", "--b71", "--b87", "--b37", "--b75", "--b38", "--b34", "--b82", "--b10", "--b10-03", "--b10-14", "--b61", "--b70", "--b25", "--b40", "--b68", "--b39", "--b52", "--b67", "--b77", "--b72", "--b50-1", "--b48", "--b79", "--b29", "--b80", "--b73", "--b74", "--b83", "--b84", "--b85", "--b89", "--b10-02", "--b10-01", "--b10-04", "--b10-05", "--b10-06", "--b10-07", "--b10-08", "--b10-12", "--b10-13", "--b10-15", "--b10-16", "--b10-17", "--b10-18", "--b10-19", "--b10-20", "--b10-09", "--b10-10", "--b10-21", "--b10-22", "--b10-11", "--b10-23"].includes(arg))
if (!directory) throw new Error("usage: render-frames.ts <directory> [<cols>x<rows> ...]")
mkdirSync(directory, { recursive: true })
try {
  if (process.argv.includes("--b10-09")) {
    const { renderB1009Frames } = await import("./render-b10-09-frames")
    await renderB1009Frames(directory, sizes)
  } else if (process.argv.includes("--b10-10")) {
    const { renderB1010Frames } = await import("./render-b10-10-frames")
    await renderB1010Frames(directory, sizes)
  } else if (b85) {
    const { renderB85Frames } = await import("./render-b85-frames")
    await renderB85Frames(directory, sizes)
  } else if (b25) {
    const { renderB25Frames } = await import("./render-b25-frames")
    await renderB25Frames(directory, sizes)
  } else if (b63) {
    const { renderB63Frames } = await import("./render-b63-frames")
    await renderB63Frames(directory, sizes)
  } else if (b08) {
    const { renderB08Frames } = await import("./render-b08-frames")
    await renderB08Frames(directory, sizes)
  } else if (b05) {
    const { renderB05Frames } = await import("./render-b05-frames")
    await renderB05Frames(directory, sizes)
  } else if (b31) {
    const { renderB31Frames } = await import("./render-b31-frames")
    await renderB31Frames(directory, sizes)
  } else if (b32) {
    const { renderB32Frames } = await import("./render-b32-frames")
    await renderB32Frames(directory, sizes)
  } else if (b15) {
    const { renderB15Frames } = await import("./render-b15-frames")
    await renderB15Frames(directory, sizes)
  } else if (ui7) {
    const { renderUi7Frames } = await import("./render-ui7-frames")
    await renderUi7Frames(directory, sizes)
  } else if (b06b07) {
    const { renderB06B07Frames } = await import("./render-b06-b07-frames")
    await renderB06B07Frames(directory, sizes)
  } else if (b04b03) {
    const { renderB04B03Frames } = await import("./render-b04-b03-frames")
    await renderB04B03Frames(directory, sizes)
  } else if (parity) {
    const { renderParityFrames } = await import("./render-b01-b02-frames")
    await renderParityFrames(directory, sizes)
  } else if (ui5) {
    const { renderUi5Frames } = await import("./render-ui5-frames")
    await renderUi5Frames(directory, sizes)
  } else if (ui4) {
    const { renderUi4Frames } = await import("./render-ui4-frames")
    await renderUi4Frames(directory, sizes)
  } else if (ui3) {
    const { renderUi3Frames } = await import("./render-ui3-frames")
    await renderUi3Frames(directory, sizes)
  } else if (b09) {
    const { renderB09Frames } = await import("./render-b09-frames")
    await renderB09Frames(directory, sizes)
  } else if (b50) {
    const { renderB50Frames } = await import("./render-b50-frames")
    await renderB50Frames(directory, sizes)
  } else if (b54) {
    const { renderB54Frames } = await import("./render-b54-frames")
    await renderB54Frames(directory, sizes)
  } else if (b19) {
    const { renderB19Frames } = await import("./render-b19-frames")
    await renderB19Frames(directory, sizes)
  } else if (b57) {
    const { renderB57Frames } = await import("./render-b57-frames")
    await renderB57Frames(directory, sizes)
  } else if (b56) {
    const { renderB56Frames } = await import("./render-b56-frames")
    await renderB56Frames(directory, sizes)
  } else if (b53) {
    const { renderB53Frames } = await import("./render-b53-frames")
    await renderB53Frames(directory, sizes)
  } else if (b41) {
    const { renderB41Frames } = await import("./render-b41-frames")
    await renderB41Frames(directory, sizes)
  } else if (b60) {
    const { renderB60Frames } = await import("./render-b60-frames")
    await renderB60Frames(directory, sizes)
  } else if (b59) {
    const { renderB59Frames } = await import("./render-b59-frames")
    await renderB59Frames(directory, sizes)
  } else if (b33) {
    const { renderB33Frames } = await import("./render-b33-frames")
    await renderB33Frames(directory, sizes)
  } else if (b16) {
    const { renderB16Frames } = await import("./render-b16-frames")
    await renderB16Frames(directory, sizes)
  } else if (b18) {
    const { renderB18Frames } = await import("./render-b18-frames")
    await renderB18Frames(directory, sizes)
  } else if (b17) {
    const { renderB17Frames } = await import("./render-b17-frames")
    await renderB17Frames(directory, sizes)
  } else if (b11) {
    const { renderB11Frames } = await import("./render-b11-frames")
    await renderB11Frames(directory, sizes)
  } else if (b12) {
    const { renderB12Frames } = await import("./render-b12-frames")
    await renderB12Frames(directory, sizes)
  } else if (b13) {
    const { renderB13Frames } = await import("./render-b13-frames")
    await renderB13Frames(directory, sizes)
  } else if (b14) {
    const { renderB14Frames } = await import("./render-b14-frames")
    await renderB14Frames(directory, sizes)
  } else if (b65) {
    const { renderB65Frames } = await import("./render-b65-frames")
    await renderB65Frames(directory, sizes)
  } else if (b66) {
    const { renderB66Frames } = await import("./render-b66-frames")
    await renderB66Frames(directory, sizes)
  } else if (b20) {
    const { renderB20Frames } = await import("./render-b20-frames")
    await renderB20Frames(directory, sizes)
  } else if (b36) {
    const { renderB36Frames } = await import("./render-b36-frames")
    await renderB36Frames(directory, sizes)
  } else if (b28) {
    const { renderB28Frames } = await import("./render-b28-frames")
    await renderB28Frames(directory, sizes)
  } else if (process.argv.includes("--b64")) {
    const { renderB64Frames } = await import("./render-b64-frames")
    await renderB64Frames(directory, sizes)
  } else if (b62) {
    const { renderB62Frames } = await import("./render-b62-frames")
    await renderB62Frames(directory, sizes)
  } else if (b22) {
    const { renderB22Frames } = await import("./render-b22-frames")
    await renderB22Frames(directory, sizes)
  } else if (b42) {
    const { renderB42Frames } = await import("./render-b42-frames")
    await renderB42Frames(directory, sizes)
  } else if (b43) {
    const { renderB43Frames } = await import("./render-b43-frames")
    await renderB43Frames(directory, sizes)
  } else if (b47) {
    const { renderB47Frames } = await import("./render-b47-frames")
    await renderB47Frames(directory, sizes)
  } else if (b51) {
    const { renderB51Frames } = await import("./render-b51-frames")
    await renderB51Frames(directory, sizes)
  } else if (b27) {
    const { renderB27Frames } = await import("./render-b27-frames")
    await renderB27Frames(directory, sizes)
  } else if (b30) {
    const { renderB30Frames } = await import("./render-b30-frames")
    await renderB30Frames(directory, sizes)
  } else if (b55) {
    const { renderB55Frames } = await import("./render-b55-frames")
    await renderB55Frames(directory, sizes)
  } else if (b76) {
    const { renderB76Frames } = await import("./render-b76-frames")
    await renderB76Frames(directory, sizes)
  } else if (b21) {
    const { renderB21Frames } = await import("./render-b21-frames")
    await renderB21Frames(directory, sizes)
  } else if (b45) {
    const { renderB45Frames } = await import("./render-b45-frames")
    await renderB45Frames(directory, sizes)
  } else if (b78) {
    const { renderB78Frames } = await import("./render-b78-frames")
    await renderB78Frames(directory, sizes)
  } else if (b44) {
    const { renderB44Frames } = await import("./render-b44-frames")
    await renderB44Frames(directory, sizes)
  } else if (b69) {
    const { renderB69Frames } = await import("./render-b69-frames")
    await renderB69Frames(directory, sizes)
  } else if (b46) {
    const { renderB46Frames } = await import("./render-b46-frames")
    await renderB46Frames(directory, sizes)
  } else if (b23) {
    const { renderB23Frames } = await import("./render-b23-frames")
    await renderB23Frames(directory, sizes)
  } else if (b49) {
    const { renderB49Frames } = await import("./render-b49-frames")
    await renderB49Frames(directory, sizes)
  } else if (b24) {
    const { renderB24Frames } = await import("./render-b24-frames")
    await renderB24Frames(directory, sizes)
  } else if (b26) {
    const { renderB26Frames } = await import("./render-b26-frames")
    await renderB26Frames(directory, sizes)
  } else if (b71) {
    const { renderB71Frames } = await import("./render-b71-frames")
    await renderB71Frames(directory, sizes)
  } else if (b87) {
    const { renderB87Frames } = await import("./render-b87-frames")
    await renderB87Frames(directory, sizes)
  } else if (b37) {
    const { renderB37Frames } = await import("./render-b37-frames")
    await renderB37Frames(directory, sizes)
  } else if (b75) {
    const { renderB75Frames } = await import("./render-b75-frames")
    await renderB75Frames(directory, sizes)
  } else if (b38) {
    const { renderB38Frames } = await import("./render-b38-frames")
    await renderB38Frames(directory, sizes)
  } else if (b34) {
    const { renderB34Frames } = await import("./render-b34-frames")
    await renderB34Frames(directory, sizes)
  } else if (b82) {
    const { renderB82Frames } = await import("./render-b82-frames")
    await renderB82Frames(directory, sizes)
  } else if (b10) {
    const { renderB10Frames } = await import("./render-b10-frames")
    await renderB10Frames(directory, sizes)
  } else if (b1003) {
    const { renderB1003Frames } = await import("./render-b10-03-frames")
    await renderB1003Frames(directory, sizes)
  } else if (b1014) {
    const { renderB1014Frames } = await import("./render-b10-14-frames")
    await renderB1014Frames(directory, sizes)
  } else if (b61) {
    const { renderB61Frames } = await import("./render-b61-frames")
    await renderB61Frames(directory, sizes)
  } else if (b70) {
    const { renderB70Frames } = await import("./render-b70-frames")
    await renderB70Frames(directory, sizes)
  } else if (b40) {
    const { renderB40Frames } = await import("./render-b40-frames")
    await renderB40Frames(directory, sizes)
  } else if (b68) {
    const { renderB68Frames } = await import("./render-b68-frames")
    await renderB68Frames(directory, sizes)
  } else if (b39) {
    const { renderB39Frames } = await import("./render-b39-frames")
    await renderB39Frames(directory, sizes)
  } else if (b52) {
    const { renderB52Frames } = await import("./render-b52-frames")
    await renderB52Frames(directory, sizes)
  } else if (b67) {
    const { renderB67Frames } = await import("./render-b67-frames")
    await renderB67Frames(directory, sizes)
  } else if (b77) {
    const { renderB77Frames } = await import("./render-b77-frames")
    await renderB77Frames(directory, sizes)
  } else if (b72) {
    const { renderB72Frames } = await import("./render-b72-frames")
    await renderB72Frames(directory, sizes)
  } else if (b501) {
    const { renderB501Frames } = await import("./render-b50-1-frames")
    await renderB501Frames(directory, sizes)
  } else if (b48) {
    const { renderB48Frames } = await import("./render-b48-frames")
    await renderB48Frames(directory, sizes)
  } else if (b79) {
    const { renderB79Frames } = await import("./render-b79-frames")
    await renderB79Frames(directory, sizes)
  } else if (b29) {
    const { renderB29Frames } = await import("./render-b29-frames")
    await renderB29Frames(directory, sizes)
  } else if (process.argv.includes("--b80")) {
    const { renderB80Frames } = await import("./render-b80-frames")
    await renderB80Frames(directory, sizes)
  } else if (b73) {
    const { renderB73Frames } = await import("./render-b73-frames")
    await renderB73Frames(directory, sizes)
  } else if (b741) {
    const { renderB741Frames } = await import("./render-b74-1-frames")
    await renderB741Frames(directory, sizes)
  } else if (b74) {
    const { renderB74Frames } = await import("./render-b74-frames")
    await renderB74Frames(directory, sizes)
  } else if (b83) {
    const { renderB83Frames } = await import("./render-b83-frames")
    await renderB83Frames(directory, sizes)
  } else if (b84) {
    const { renderB84Frames } = await import("./render-b84-frames")
    await renderB84Frames(directory, sizes)
  } else if (b88) {
    const { renderB88Frames } = await import("./render-b88-frames")
    await renderB88Frames(directory, sizes)
  } else if (b35) {
    const { renderB35Frames } = await import("./render-b35-frames")
    await renderB35Frames(directory, sizes)
  } else if (b86) {
    const { renderB86Frames } = await import("./render-b86-frames")
    await renderB86Frames(directory, sizes)
  } else if (b89) {
    const { renderB89Frames } = await import("./render-b89-frames")
    await renderB89Frames(directory, sizes)
  } else if (b1002) {
    const { renderB1002Frames } = await import("./render-b10-02-frames")
    await renderB1002Frames(directory, sizes)
  } else if (b1001) {
    const { renderB1001Frames } = await import("./render-b10-01-frames")
    await renderB1001Frames(directory, sizes)
  } else if (b1004) {
    const { renderB1004Frames } = await import("./render-b10-04-frames")
    await renderB1004Frames(directory, sizes)
  } else if (process.argv.includes("--b10-05")) {
    const { renderB1005Frames } = await import("./render-b10-05-frames")
    await renderB1005Frames(directory, sizes)
  } else if (process.argv.includes("--b10-06")) {
    const { renderB1006Frames } = await import("./render-b10-06-frames")
    await renderB1006Frames(directory, sizes)
  } else if (process.argv.includes("--b10-07")) {
    const { renderB1007Frames } = await import("./render-b10-07-frames")
    await renderB1007Frames(directory, sizes)
  } else if (process.argv.includes("--b10-08")) {
    const { renderB1008Frames } = await import("./render-b10-08-frames")
    await renderB1008Frames(directory, sizes)
  } else if (b1012) {
    const { renderB1012Frames } = await import("./render-b10-12-frames")
    await renderB1012Frames(directory, sizes)
  } else if (b1013) {
    const { renderB1013Frames } = await import("./render-b10-13-frames")
    await renderB1013Frames(directory, sizes)
  } else if (b1015) {
    const { renderB1015Frames } = await import("./render-b10-15-frames")
    await renderB1015Frames(directory, sizes)
  } else if (b1016) {
    const { renderB1016Frames } = await import("./render-b10-16-frames")
    await renderB1016Frames(directory, sizes)
  } else if (b1017) {
    const { renderB1017Frames } = await import("./render-b10-17-frames")
    await renderB1017Frames(directory, sizes)
  } else if (b1018) {
    const { renderB1018Frames } = await import("./render-b10-18-frames")
    await renderB1018Frames(directory, sizes)
  } else if (b1019) {
    const { renderB1019Frames } = await import("./render-b10-19-frames")
    await renderB1019Frames(directory, sizes)
  } else if (b1020) {
    const { renderB1020Frames } = await import("./render-b10-20-frames")
    await renderB1020Frames(directory, sizes)
  } else if (b1011) {
    const { renderB1011Frames } = await import("./render-b10-11-frames")
    await renderB1011Frames(directory, sizes)
  } else if (process.argv.includes("--b10-23")) {
    const { renderB1023Frames } = await import("./render-b10-23-frames")
    await renderB1023Frames(directory, sizes)
  } else if (b1021) {
    const { renderB1021Frames } = await import("./render-b10-21-frames")
    await renderB1021Frames(directory, sizes)
  } else if (b1022) {
    const { renderB1022Frames } = await import("./render-b10-22-frames")
    await renderB1022Frames(directory, sizes)
  } else for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const sessionId = ids("session")
    const runningId = ids("session")
    const waitingId = ids("session")
    const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: "/work/mendcode", reply: (command) => {
      const result = command.type === "session.list" ? { sessions: [
        { sessionId, directory: "/work/mendcode", title: "Chat chrome", createdAt: NOW - 3_600_000, updatedAt: NOW - 60_000, state: "idle" },
        { sessionId: runningId, directory: "/work/mendcode", title: "Reconnect after suspend", createdAt: NOW - 7_200_000, updatedAt: NOW - 600_000, state: "generating" },
        { sessionId: waitingId, directory: "/work/mendcode", title: "Review the client", createdAt: NOW - 8_000_000, updatedAt: NOW - 900_000, state: "waiting_approval" },
      ] } : command.type === "models.list" ? { engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna", effort: "medium" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} } : command.type === "git.branch" ? { branch: "main" } : command.type === "changes.query" ? { root: "/work/mendcode", files: [], omittedFiles: 0 } : undefined
      return { ok: true, ...(result ? { result } : {}) } as CommandReply
    } })
    const save = (screen: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`frame exceeds ${size}: ${screen}`)
      const rows = Array.from({ length: height }, (_, row) => fit(frame[row] ?? [], width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI in frame: ${screen}`)
      writeFileSync(path.join(directory, `${screen}-${size}.txt`), `${rows.join("\n")}\n`)
    }
    h.app.applySettings({})
    await Bun.sleep(5)
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: runningId, directory: "/work/mendcode", title: "Reconnect after suspend", state: "generating", updatedAt: NOW - 600_000 })
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: waitingId, directory: "/work/mendcode", title: "Review the client", state: "waiting_approval", updatedAt: NOW - 900_000 })
    save("home")
    // UI-2: use the actual app renderer with isolated profiles for each identity/layout.
    for (const logoKind of ["wordmark", "mascot", "both", "custom", "none"] as const) {
      for (const homeLayout of ["centered", "split"] as const) {
        for (const homeRightPanel of ["actions", "agentManager"] as const) {
          const dataDir = tempDir()
          writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, logoKind, homeLayout, homeRightPanel, customAscii: "  /\\\n <++>\n  \\/" })
          const scene = appHarness({ width, height, sessionId, dataDir, directory: "/work/mendcode", version: "0.4.2", reply: (command) => {
            const result = command.type === "models.list" ? { engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna", effort: "medium" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} } : command.type === "daemon.info" ? { engine: "faux", dataDir, pid: 1, buildId: "ui2-local" } : command.type === "mcp.status" ? { servers: [], issues: [] } : command.type === "memory.list" ? { memories: [] } : command.type === "recipes.list" ? { recipes: [] } : undefined
            return { ok: true, ...(result ? { result } : {}) } as CommandReply
          } })
          const sceneSave = (name: string) => {
            scene.app.render()
            const frame = scene.frames.at(-1) ?? []
            if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
            writeFileSync(path.join(directory, `${name}-${size}.txt`), `${frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")}\n`)
          }
          scene.app.applySettings({ onboarded: true })
          await Bun.sleep(5)
          if (homeRightPanel === "agentManager") {
            scene.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: runningId, directory: "/work/mendcode", title: "Reconnect after suspend", state: "generating", updatedAt: NOW - 600_000 })
            scene.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: waitingId, directory: "/work/mendcode", title: "Review the client", state: "waiting_approval", updatedAt: NOW - 900_000 })
            const loop: Loop = { loopId: ids("loop"), sessionId: ids("session"), name: "Watch checks", directory: "/work/mendcode", objective: "Watch local checks", state: "running", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" }, runs: 1, history: [], createdAt: NOW - 600_000, updatedAt: NOW - 600_000 }
            scene.app.onGlobal({ type: "loop.changed", gseq: 3, at: NOW, loop })
          }
          if (logoKind === "wordmark" && homeLayout === "centered" && homeRightPanel === "actions") {
            await scene.type("/customize\r")
            for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("logoFont"); i++) await scene.app.onKey("\x1b[B")
            for (const font of LOGO_FONTS) {
              sceneSave(`customize-font-${font}`)
              await scene.app.onKey("\x1b[C")
            }
            await scene.app.onKey("\x1b")
          }
          sceneSave(`home-${logoKind}-${homeLayout}-${homeRightPanel === "actions" ? "actions" : "agent-view"}`)
          if (logoKind === "both" && homeLayout === "split" && homeRightPanel === "actions") {
            await scene.type("/customize\r")
            sceneSave("customize-home")
            let previous = 0
            for (const [field, name] of [["promptChrome", "prompt"], ["contextBar", "session"], ["sidebar", "terminal"], ["customAscii", "ascii"]] as const) {
              const index = CUSTOMIZE_ROWS.indexOf(field)
              const move = index >= previous ? "\x1b[B" : "\x1b[A"
              for (let i = 0; i < Math.abs(index - previous); i++) await scene.app.onKey(move)
              previous = index
              sceneSave(`customize-${name}`)
            }
            await scene.app.onKey("\x1b")
            await scene.type("/setup\r")
            sceneSave("setup")
            for (let i = 0; i < SETUP_ROWS.indexOf("homeLayout"); i++) await scene.app.onKey("\x1b[B")
            sceneSave("setup-welcome")
            await scene.app.onKey("\x1b")
            await scene.type("/pet\r")
            sceneSave("pet-mend-ascii")
          }
          await scene.app.onKey("\x03")
        }
      }
    }
    await h.app.onKey("\x10")
    await h.type("Home welcome mode")
    await h.app.onKey("\r")
    save("home-welcome-picker")
    await h.app.onKey("\x1b")
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("Show me the chat layout", "## Chat chrome\n\nKeep **messages** readable and `Tab` predictable.\n\n- One footer\n- Sessions on the left")
    const turnId = ids("turn")
    const itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read", path: "docs/layout.md" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: "Terminal layout and session navigation" })
    chat.emit({ type: "usage.recorded", turnId, provider: "codex", model: "gpt-6-luna", input: 24_000, output: 600, reasoning: 200, cacheRead: 0, cacheWrite: 0 })
    chat.emit({ type: "turn.completed", turnId })
    chat.exchange("What does Tab do?", "It completes the command text. Press Enter to run it.")
    await Bun.sleep(5)
    save("chat")
    save("chat-wide")
    await h.type("/btw\t")
    save("chat-btw-tab")
    await h.app.onKey("\x1b")
    await h.type("/pet\r")
    await h.app.onKey("\r")
    const activeTurn = ids("turn")
    chat.emit({ type: "turn.started", turnId: activeTurn, queueId: ids("queue") })
    chat.emit({ type: "foreground.state", state: "tool", turnId: activeTurn })
    const toolItem = ids("item")
    chat.emit({ type: "item.started", turnId: activeTurn, itemId: toolItem, kind: "tool_call", meta: { tool: "test" } })
    save("chat-mend-ascii")
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("contextBar"); i++) await h.app.onKey("\x1b[B")
    save("customize-session-live")
    for (let i = CUSTOMIZE_ROWS.indexOf("contextBar"); i < CUSTOMIZE_ROWS.indexOf("activityStates"); i++) await h.app.onKey("\x1b[B")
    save("customize-activity-live")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
} finally {
  cleanTemps()
}
