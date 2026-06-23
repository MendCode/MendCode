import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import path from "path"

export type ReviewLineKind = "context" | "added" | "removed" | "meta"
export type ReviewCommentAuthor = "user" | "agent" | "assistant"
export type ReviewLineSide = "old" | "new" | "both"

export type ReviewLine = {
  id: string
  kind: ReviewLineKind
  oldLine?: number
  newLine?: number
  text: string
}

export type ReviewBlock = {
  id: string
  index: number
  header: string
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  lines: ReviewLine[]
}

export type ReviewFile = {
  id: string
  path: string
  previousPath?: string
  changeType: FileDiffMetadata["type"] | "unknown"
  additions: number
  deletions: number
  blocks: ReviewBlock[]
  rawPatch?: string
  tooLarge?: boolean
}

export type ReviewComment = {
  id: string
  author: ReviewCommentAuthor
  filePath: string
  blockIndex: number
  side: ReviewLineSide
  line?: number
  body: string
  stale: boolean
  createdAt: string
}

export type ReviewSelection = {
  filePath?: string
  blockIndex?: number
  lineID?: string
}

export type ReviewState = {
  id: string
  workspaceRoot: string
  source: "working-tree" | "session"
  files: ReviewFile[]
  comments: ReviewComment[]
  selection: ReviewSelection
  loadedAt: string
  summary?: string
}

export type ReviewLayout = {
  tiny: boolean
  medium: boolean
  wide: boolean
  sidebarWidth: number
  contentWidth: number
}

type ExternalBlock = {
  additionStart: number
  additionCount: number
  additionLineIndex: number
  deletionStart: number
  deletionCount: number
  deletionLineIndex: number
  noEOFCRAdditions: boolean
  noEOFCRDeletions: boolean
} & Record<string, unknown>

type ExternalBlockContent =
  | {
      type: "context"
      lines: number
      additionLineIndex: number
      deletionLineIndex: number
    }
  | {
      type: "change"
      deletions: number
      deletionLineIndex: number
      additions: number
      additionLineIndex: number
    }

export function reviewLayoutForDimensions(input: { width: number; height: number }): ReviewLayout {
  const width = Math.max(40, input.width)
  return {
    tiny: width < 88 || input.height < 24,
    medium: width >= 112 && input.height >= 26,
    wide: width >= 132 && input.height >= 28,
    sidebarWidth: Math.min(42, Math.max(26, Math.floor(width * 0.28))),
    contentWidth: Math.max(36, width - 6),
  }
}

export function shouldChangesRouteHandleKey(input: { dialogOpen: boolean; defaultPrevented?: boolean }) {
  return !input.dialogOpen && input.defaultPrevented !== true
}

export function createReviewState(input: {
  workspaceRoot: string
  diff: string
  source?: ReviewState["source"]
  now?: string
}): ReviewState {
  const files = parseReviewFiles(input.diff)
  return {
    id: `review:${input.workspaceRoot}:${hash(input.diff)}`,
    workspaceRoot: input.workspaceRoot,
    source: input.source ?? "working-tree",
    files,
    comments: [],
    selection: {
      filePath: files[0]?.path,
      blockIndex: files[0]?.blocks[0]?.index,
      lineID: files[0]?.blocks[0]?.lines.find((line) => line.kind !== "meta")?.id,
    },
    loadedAt: input.now ?? new Date().toISOString(),
    summary: files.length ? undefined : "No working tree diff found.",
  }
}

export function parseReviewFiles(diff: string): ReviewFile[] {
  if (!diff.trim()) return []
  const parsed = parsePatchFiles(diff)
  const rawByPath = splitRawPatchByFile(diff)
  return parsed.flatMap((patch) =>
    patch.files.map((file, index) => {
      const externalBlocks = externalBlocksForFile(file)
      const blocks = externalBlocks.map((block, blockIndex) => reviewBlockFromPierre(file, block, blockIndex))
      return {
        id: stableFileID(file.name || `file-${index}`),
        path: cleanDiffPath(file.name || `file-${index}`),
        previousPath: file.prevName ? cleanDiffPath(file.prevName) : undefined,
        changeType: file.type ?? "unknown",
        additions: blocks.reduce(
          (total, block) => total + block.lines.filter((line) => line.kind === "added").length,
          0,
        ),
        deletions: blocks.reduce(
          (total, block) => total + block.lines.filter((line) => line.kind === "removed").length,
          0,
        ),
        blocks,
        rawPatch: rawByPath.get(cleanDiffPath(file.name || "")),
      } satisfies ReviewFile
    }),
  )
}

export function selectNextFile(state: ReviewState, direction: 1 | -1): ReviewSelection {
  if (!state.files.length) return {}
  const current = Math.max(
    0,
    state.files.findIndex((file) => file.path === state.selection.filePath),
  )
  const next = state.files[(current + direction + state.files.length) % state.files.length]!
  const block = next.blocks[0]
  return { filePath: next.path, blockIndex: block?.index, lineID: firstSelectableLine(block)?.id }
}

export function selectNextBlock(state: ReviewState, direction: 1 | -1): ReviewSelection {
  if (!state.files.length) return {}
  const fileIndex = Math.max(
    0,
    state.files.findIndex((file) => file.path === state.selection.filePath),
  )
  const file = state.files[fileIndex]!
  if (!file.blocks.length) return { filePath: file.path }
  const current = Math.max(
    0,
    file.blocks.findIndex((block) => block.index === state.selection.blockIndex),
  )
  const next = file.blocks[current + direction]
  if (next) return { filePath: file.path, blockIndex: next.index, lineID: firstSelectableLine(next)?.id }
  const nextFile = state.files[(fileIndex + direction + state.files.length) % state.files.length]!
  const block = direction > 0 ? nextFile.blocks[0] : nextFile.blocks.at(-1)
  return { filePath: nextFile.path, blockIndex: block?.index, lineID: firstSelectableLine(block)?.id }
}

export function selectNextLine(state: ReviewState, direction: 1 | -1): ReviewSelection {
  return selectLineByOffset(state, direction)
}

export function selectLineByOffset(state: ReviewState, offset: number): ReviewSelection {
  const file = activeReviewFile(state)
  if (!file) return {}
  const lines = selectableLinesForFile(file)
  if (!lines.length) return { filePath: file.path }
  const current = selectedReviewLineOrdinal(state)
  const next = lines[clamp(current + offset, 0, lines.length - 1)]!
  return { filePath: file.path, blockIndex: next.block.index, lineID: next.line.id }
}

export function selectFileLineByOrdinal(state: ReviewState, ordinal: number): ReviewSelection {
  const file = activeReviewFile(state)
  if (!file) return {}
  const lines = selectableLinesForFile(file)
  if (!lines.length) return { filePath: file.path }
  const next = lines[clamp(ordinal, 0, lines.length - 1)]!
  return { filePath: file.path, blockIndex: next.block.index, lineID: next.line.id }
}

export function selectLineByNumber(state: ReviewState, target: number): ReviewSelection {
  const file = activeReviewFile(state)
  if (!file) return {}
  const lines = selectableLinesForFile(file)
  if (!lines.length) return { filePath: file.path }
  const exact = lines.find((entry) => entry.line.newLine === target || entry.line.oldLine === target)
  if (exact) return { filePath: file.path, blockIndex: exact.block.index, lineID: exact.line.id }
  const after = lines.find((entry) => (entry.line.newLine ?? entry.line.oldLine ?? 0) >= target)
  const next = after ?? lines.at(-1)!
  return { filePath: file.path, blockIndex: next.block.index, lineID: next.line.id }
}

export function selectedReviewLineOrdinal(state: ReviewState) {
  const file = activeReviewFile(state)
  if (!file) return 0
  const lines = selectableLinesForFile(file)
  const index = lines.findIndex((entry) => entry.line.id === state.selection.lineID)
  return index < 0 ? 0 : index
}

export function selectableLineCount(state: ReviewState) {
  return selectableLinesForFile(activeReviewFile(state)).length
}

export function activeReviewFile(state: ReviewState) {
  return state.files.find((file) => file.path === state.selection.filePath) ?? state.files[0]
}

export function activeReviewBlock(state: ReviewState) {
  const file = activeReviewFile(state)
  if (!file) return undefined
  return file.blocks.find((block) => block.index === state.selection.blockIndex) ?? file.blocks[0]
}

export function activeReviewLine(state: ReviewState) {
  const block = activeReviewBlock(state)
  if (!block) return undefined
  return block.lines.find((line) => line.id === state.selection.lineID) ?? firstSelectableLine(block)
}

export function reviewStats(files: ReviewFile[]) {
  return {
    files: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    blocks: files.reduce((total, file) => total + file.blocks.length, 0),
  }
}

function reviewBlockFromPierre(file: FileDiffMetadata, block: ExternalBlock, index: number): ReviewBlock {
  const lines: ReviewLine[] = []
  const oldBase = block.deletionStart
  const newBase = block.additionStart
  const oldIndexBase = block.deletionLineIndex
  const newIndexBase = block.additionLineIndex
  const blockID = `${stableFileID(file.name)}:${index}`
  for (const content of externalBlockContent(block)) {
    if (content.type === "context") {
      for (let i = 0; i < content.lines; i++) {
        const oldLine = oldBase + content.deletionLineIndex - oldIndexBase + i
        const newLine = newBase + content.additionLineIndex - newIndexBase + i
        lines.push({
          id: `${blockID}:ctx:${oldLine}:${newLine}`,
          kind: "context",
          oldLine,
          newLine,
          text: cleanLine(
            file.additionLines[content.additionLineIndex + i] ??
              file.deletionLines[content.deletionLineIndex + i] ??
              "",
          ),
        })
      }
      continue
    }
    for (let i = 0; i < content.deletions; i++) {
      const oldLine = oldBase + content.deletionLineIndex - oldIndexBase + i
      lines.push({
        id: `${blockID}:old:${oldLine}`,
        kind: "removed",
        oldLine,
        text: cleanLine(file.deletionLines[content.deletionLineIndex + i] ?? ""),
      })
    }
    for (let i = 0; i < content.additions; i++) {
      const newLine = newBase + content.additionLineIndex - newIndexBase + i
      lines.push({
        id: `${blockID}:new:${newLine}`,
        kind: "added",
        newLine,
        text: cleanLine(file.additionLines[content.additionLineIndex + i] ?? ""),
      })
    }
  }
  if (block.noEOFCRAdditions || block.noEOFCRDeletions) {
    lines.push({ id: `${blockID}:meta:no-newline`, kind: "meta", text: "No newline at end of file" })
  }
  return {
    id: blockID,
    index,
    header: (
      externalBlockHeader(block) ??
      `@@ -${block.deletionStart},${block.deletionCount} +${block.additionStart},${block.additionCount} @@`
    ).trim(),
    oldStart: block.deletionStart,
    oldEnd: block.deletionStart + Math.max(0, block.deletionCount - 1),
    newStart: block.additionStart,
    newEnd: block.additionStart + Math.max(0, block.additionCount - 1),
    lines,
  }
}

function externalBlocksForFile(file: FileDiffMetadata) {
  for (const value of Object.values(file as unknown as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every(isExternalBlock)) return value
  }
  return []
}

function externalBlockContent(block: ExternalBlock) {
  for (const value of Object.values(block)) {
    if (Array.isArray(value) && value.every(isExternalBlockContent)) return value
  }
  return []
}

function externalBlockHeader(block: ExternalBlock) {
  return Object.values(block).find((value): value is string => typeof value === "string" && value.startsWith("@@"))
}

function isExternalBlock(value: unknown): value is ExternalBlock {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<Record<keyof ExternalBlock, unknown>>
  return (
    typeof candidate.additionStart === "number" &&
    typeof candidate.additionCount === "number" &&
    typeof candidate.additionLineIndex === "number" &&
    typeof candidate.deletionStart === "number" &&
    typeof candidate.deletionCount === "number" &&
    typeof candidate.deletionLineIndex === "number"
  )
}

function isExternalBlockContent(value: unknown): value is ExternalBlockContent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === "context") {
    return (
      typeof candidate.lines === "number" &&
      typeof candidate.additionLineIndex === "number" &&
      typeof candidate.deletionLineIndex === "number"
    )
  }
  if (candidate.type === "change") {
    return (
      typeof candidate.additions === "number" &&
      typeof candidate.deletions === "number" &&
      typeof candidate.additionLineIndex === "number" &&
      typeof candidate.deletionLineIndex === "number"
    )
  }
  return false
}

function firstSelectableLine(block: ReviewBlock | undefined) {
  return block?.lines.find((line) => line.kind !== "meta")
}

function selectableLinesForFile(file: ReviewFile | undefined) {
  if (!file) return []
  return file.blocks.flatMap((block) =>
    block.lines
      .filter((line) => line.kind !== "meta")
      .map((line) => ({
        block,
        line,
      })),
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function splitRawPatchByFile(diff: string) {
  const files = new Map<string, string>()
  const cblocks = diff.split(/\n(?=diff --git )/)
  for (const cblock of cblocks) {
    const match = cblock.match(/^diff --git a\/(.+?) b\/(.+?)\n/)
    if (!match) continue
    files.set(cleanDiffPath(match[2]!), cblock)
  }
  return files
}

function cleanLine(value: string) {
  return value.replace(/\r?\n$/, "")
}

function cleanDiffPath(value: string) {
  const normalized = value.replace(/^[ab]\//, "")
  if (!path.isAbsolute(normalized)) return normalized
  const relative = path.relative(process.cwd(), normalized)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return normalized
  return relative.split(path.sep).join("/")
}

function stableFileID(value: string) {
  return cleanDiffPath(value).replace(/[^A-Za-z0-9_.-]+/g, "_") || "file"
}

function hash(value: string) {
  let result = 5381
  for (let i = 0; i < value.length; i++) result = ((result << 5) + result) ^ value.charCodeAt(i)
  return (result >>> 0).toString(36)
}
