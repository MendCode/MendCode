import type { CommandInput } from "@mendcode/client"

type PetRequest = Extract<CommandInput, { type: "pet.manage" }>["input"]

export const PET_IMPORT_USAGE = "Use import <file.png|file.gif|folder> [--name N] [--frames COLSxROWS] [--ms N] [--filter pixel|smooth] [--no-key]"

/** Words split at spaces; a part in double quotes (a path or a name with spaces) stays one word. */
const quoted = (text: string) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!)

/** `import <path> [flags]`: the path as typed (the terminal makes it absolute before it is sent). */
function parseImport(words: string[]): PetRequest {
  const request: { action: "import"; path: string; name?: string; frames?: { columns: number; rows: number }; key?: boolean; filter?: "pixel" | "smooth"; ms?: number } = { action: "import", path: "" }
  const rest: string[] = []
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!
    const value = () => {
      const next = words[++at]
      if (next === undefined) throw new Error(`${word} needs a value · ${PET_IMPORT_USAGE}`)
      return next
    }
    if (word === "--name") request.name = value()
    else if (word === "--frames") {
      const match = /^(\d{1,2})x(\d{1,2})$/i.exec(value())
      if (!match) throw new Error("--frames needs COLSxROWS, like 4x1")
      request.frames = { columns: Number(match[1]), rows: Number(match[2]) }
    } else if (word === "--ms") {
      request.ms = Number(value())
      if (!Number.isInteger(request.ms) || request.ms < 20 || request.ms > 10_000) throw new Error("--ms is the time of one frame: 20 to 10000")
    } else if (word === "--filter") {
      const filter = value()
      if (filter !== "pixel" && filter !== "smooth") throw new Error("--filter is pixel or smooth")
      request.filter = filter
    } else if (word === "--no-key") request.key = false
    else if (word.startsWith("--")) throw new Error(`Unknown option ${word} · ${PET_IMPORT_USAGE}`)
    else rest.push(word)
  }
  if (rest.length !== 1) throw new Error(rest.length === 0 ? PET_IMPORT_USAGE : "One path at a time; put a path with spaces in double quotes")
  return { ...request, path: rest[0]! }
}

export function parsePetCommand(text: string): PetRequest | undefined {
  const [action, ...words] = text.trim().split(/\s+/)
  if (action === "import") return parseImport(quoted(text.trim()).slice(1))
  if (!["new", "regen", "rename", "delete", "export"].includes(action!)) return undefined
  if (action === "new" || action === "regen") {
    const cost = words.indexOf("--usd")
    let unitUsd: number | undefined
    if (cost >= 0) {
      if (!words[cost + 1]) throw new Error("--usd needs your estimated USD per image call")
      unitUsd = Number(words[cost + 1])
      if (!Number.isFinite(unitUsd) || unitUsd <= 0 || unitUsd > 100) throw new Error("--usd must be greater than zero and at most 100")
      words.splice(cost, 2)
    }
    const price = unitUsd === undefined ? {} : { unitUsd }
    const optional = words.includes("--optional")
    if (optional) words.splice(words.indexOf("--optional"), 1)
    const framesAt = words.indexOf("--frames")
    let frames: number | undefined
    if (framesAt >= 0) {
      frames = Number(words[framesAt + 1])
      if (!Number.isInteger(frames) || frames < 1 || frames > 4) throw new Error("--frames is how many frames each state gets: 1 to 4, one image call each")
      words.splice(framesAt, 2)
    }
    if (action === "new") {
      const description = words.join(" ")
      if (!description || description.length > 600) throw new Error("Describe the pet in 1–600 characters")
      return { action: "plan", description, ...price, optional, ...(frames && frames > 1 ? { frames } : {}) }
    }
    if (words.length !== 2 || optional || frames !== undefined) throw new Error("Use regen <pet-id> <state> [--usd <estimate>]")
    return { action: "plan-state", petId: words[0]!.replace(/^user:/, ""), state: words[1] as Extract<PetRequest, { action: "plan-state" }>["state"], ...price }
  }
  const petId = words.shift()?.replace(/^user:/, "")
  if (!petId) throw new Error("Select a generated pet ID from /pet")
  if (action === "rename") {
    if (!words.length) throw new Error("Use rename <pet-id> <name>")
    return { action: "rename", petId, name: words.join(" ") }
  }
  if (action === "delete") {
    if (words.join(" ") !== "--confirm") throw new Error("Use delete <pet-id> --confirm to move it to Trash")
    return { action: "delete", petId, confirmed: true }
  }
  if (words.length) throw new Error("Use export <pet-id>")
  return { action: "export", petId }
}
