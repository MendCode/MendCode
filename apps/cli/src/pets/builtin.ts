import type { PetLayout } from "../../../../packages/protocol/src/pet-data"
import mendGirlSheet from "../../assets/pets/mendgirl.webp" with { type: "file" }
import type { PetInfo } from "./manifest"

/**
 * MendGirl's frames: 30 cells of 200 x 198 in six columns. The sheet is the owner's own art (MendGirl, with neko ears, and her
 * little robot), reduced from 352-pixel cells to just above the size any pet is drawn at with the default cell, as a lossy WebP.
 */
const MENDGIRL_LAYOUT: PetLayout = {
  art: "smooth",
  cell: { width: 200, height: 198 },
  columns: 6,
  states: {
    idle: [[0, 2600], [1, 140], [2, 900]],
    running: [[3, 240], [4, 240], [5, 240], [6, 240]],
    waiting: [[7, 500], [8, 250], [9, 350]],
    review: [[10, 700], [11, 300], [12, 1400]],
    failed: [[13, 450], [14, 450], [15, 450]],
    waving: [[16, 1100], [17, 160]],
    jumping: [[18, 1100]],
    thinking: [[19, 420], [20, 420], [21, 420]],
    compacting: [[22, 360], [23, 360], [24, 360]],
    agents: [[25, 380], [26, 380], [27, 380]],
    sleeping: [[28, 1400], [29, 1400]],
  },
}

/**
 * The pets that ship inside MendCode beside the ASCII Mend (`builtin:<id>`). This module is imported only when the pet list is
 * read (`/pet`, `/mascot`, a chosen pet), and the sheet is a file inside the executable: nothing is decoded until one is shown.
 */
export const BUILT_IN_PETS: readonly PetInfo[] = [
  { ref: "builtin:mendgirl", id: "mendgirl", displayName: "MendGirl", description: "MendGirl, with neko ears, and her little robot. Art by Obed", sheetPath: mendGirlSheet, version: 1, layout: MENDGIRL_LAYOUT },
]
