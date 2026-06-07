export type SubagentTaskColorEntry = {
  callID?: string
  subagentType: string
}

function hashString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

export function subagentTaskColorIndex(
  entries: SubagentTaskColorEntry[],
  callID: string | undefined,
  paletteLength: number,
) {
  if (paletteLength <= 1) return 0

  let previous: number | undefined
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    let color = (hashString(entry.subagentType) + index) % paletteLength
    if (previous !== undefined && color === previous) color = (color + 1) % paletteLength
    if (entry.callID === callID) return color
    previous = color
  }

  return callID ? hashString(callID) % paletteLength : 0
}
