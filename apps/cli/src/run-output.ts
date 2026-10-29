import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseAnswerJson, unsupportedKeywords, validateJson } from "./output-schema"

export type RunFinish = { ok: true; text: string } | { ok: false; errors: string[]; io?: true }

export type RunOutput = {
  /** Added to the session's system prompt so the model answers in the required shape. */
  instruction?: string
  /** True when the answer must be held back until it is validated (nothing partial reaches stdout). */
  hold: boolean
  finish(message: string): Promise<RunFinish>
}

/**
 * `--output-schema FILE` and `-o/--output-last-message FILE` for a headless run. Files resolve against the shell's
 * working directory. A schema file that cannot be read, parsed or supported is a usage error raised before any
 * session exists. The last message is written only for a run that completed and, with a schema, validated.
 */
export async function loadRunOutput({ schemaFile, outputFile, cwd }: { schemaFile?: string; outputFile?: string; cwd: string }): Promise<RunOutput> {
  let schema: unknown
  if (schemaFile !== undefined) {
    let text: string
    try { text = await readFile(path.resolve(cwd, schemaFile), "utf8") } catch (error) {
      throw new Error(`--output-schema cannot read ${schemaFile}: ${(error as NodeJS.ErrnoException).code ?? "read error"}`)
    }
    try { schema = JSON.parse(text) } catch { throw new Error(`--output-schema ${schemaFile} is not valid JSON`) }
    const problems = unsupportedKeywords(schema)
    if (problems.length) throw new Error(`--output-schema ${schemaFile}:\n  ${problems.join("\n  ")}`)
  }
  const write = async (text: string) => {
    if (outputFile === undefined) return
    const target = path.resolve(cwd, outputFile)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  return {
    ...(schema === undefined ? {} : { instruction: `Your final answer must be one JSON document that conforms to this JSON Schema, with no prose and no code fence around it:\n${JSON.stringify(schema)}` }),
    hold: schema !== undefined,
    async finish(message) {
      let text = message
      if (schema !== undefined) {
        const parsed = parseAnswerJson(message)
        if (!parsed.ok) return { ok: false, errors: [parsed.error] }
        const problems = validateJson(schema, parsed.value)
        if (problems.length) return { ok: false, errors: problems }
        text = JSON.stringify(parsed.value)
      }
      try { await write(text) } catch (error) { return { ok: false, io: true, errors: [`--output-last-message cannot write ${outputFile}: ${(error as NodeJS.ErrnoException).code ?? "write error"}`] } }
      return { ok: true, text }
    },
  }
}
