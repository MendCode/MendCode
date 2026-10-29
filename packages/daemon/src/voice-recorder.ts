import type { VoiceRecorder } from "./voice"

type Tool = { bin: string; args(file: string): string[] }
const PCM = ["-r", "16000", "-c", "1", "-b", "16"]
const sox = (file: string) => ["-q", "-d", ...PCM, file]
const ffmpeg = (input: string[]) => (file: string) => ["-hide_banner", "-loglevel", "error", "-y", ...input, "-ar", "16000", "-ac", "1", file]

/** Recorders in preference order for a platform; every one writes 16 kHz mono PCM WAV and finalizes it on SIGINT. */
export function recorderTools(platform: NodeJS.Platform): Tool[] {
  const tools: Tool[] = [
    { bin: "rec", args: (file) => ["-q", ...PCM, file] },
    { bin: "sox", args: sox },
  ]
  if (platform === "linux") tools.push({ bin: "arecord", args: (file) => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", file] }, { bin: "ffmpeg", args: ffmpeg(["-f", "pulse", "-i", "default"]) })
  if (platform === "darwin") tools.push({ bin: "ffmpeg", args: ffmpeg(["-f", "avfoundation", "-i", ":default"]) })
  return tools
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Spawns the first installed recorder with an argument array; nothing is installed or configured on the user's behalf. */
export function createVoiceRecorder(options: { platform?: NodeJS.Platform; which?: (bin: string) => string | null } = {}): VoiceRecorder {
  const which = options.which ?? ((bin: string) => Bun.which(bin))
  const tools = recorderTools(options.platform ?? process.platform)
  const find = () => tools.find((tool) => which(tool.bin))
  return {
    name: () => find()?.bin,
    async start(file) {
      const tool = find()
      if (!tool) throw new Error("no recorder found; install sox (rec), arecord or ffmpeg")
      const child = Bun.spawn([tool.bin, ...tool.args(file)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      const early = await Promise.race([child.exited.then(() => true), sleep(300).then(() => false)])
      if (early) throw new Error(`${tool.bin} stopped right away; check the microphone and its permission`)
      return {
        async stop() {
          if (child.exitCode !== null) return
          child.kill("SIGINT")
          await Promise.race([child.exited, sleep(3000)])
          if (child.exitCode === null) child.kill()
        },
        kill: () => child.kill(),
      }
    },
  }
}
