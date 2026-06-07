export type SlashAutocompleteTrigger = {
  index: number
}

export type SlashCommandInvocation = {
  name: string
  arguments: string
}

export function findSlashAutocompleteTrigger(value: string, offset: number): SlashAutocompleteTrigger | undefined {
  if (offset <= 0) return

  const text = value.slice(0, offset)
  const index = text.lastIndexOf("/")
  if (index === -1) return

  const before = index === 0 ? undefined : value[index - 1]
  if (before !== undefined && !/\s/.test(before)) return

  const between = value.slice(index + 1, offset)
  if (between.match(/\s/)) return

  return { index }
}

export function findSlashCommandInvocation(
  inputText: string,
  commandExists: (name: string) => boolean,
): SlashCommandInvocation | undefined {
  const firstLineEnd = inputText.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
  const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
  const matches = firstLine.matchAll(/(^|\s)\/([^\s/]+)(?=\s|$)/g)
  const match = Array.from(matches).find((item) => item[2] && commandExists(item[2]))
  if (!match?.[2]) return

  const name = match[2]
  const slashStart = (match.index ?? 0) + match[1].length
  const before = firstLine.slice(0, slashStart).trim()
  const after = firstLine.slice(slashStart + name.length + 1).trim()
  const args = [before, after].filter(Boolean).join(" ")

  return {
    name,
    arguments: args + (restOfInput ? (args ? "\n" : "") + restOfInput : ""),
  }
}
