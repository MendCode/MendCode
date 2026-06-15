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
  const match = firstLine.match(/^\s*\/([^\s/]+)(?=\s|$)/)
  const name = match?.[1]
  if (!name || !commandExists(name)) return

  const after = firstLine.slice(match[0].length).trim()
  const args = after

  return {
    name,
    arguments: args + (restOfInput ? (args ? "\n" : "") + restOfInput : ""),
  }
}
