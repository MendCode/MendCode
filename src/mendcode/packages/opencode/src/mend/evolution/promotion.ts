import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { WorkflowPlan } from "@/session/workflow-plan"
import { makeRuntime } from "@/effect/run-service"
import { WorkflowService } from "@/session/workflow-service"
import { WithInstance } from "@/project/with-instance"
import { WorkflowDefinitionID } from "@/session/workflow"
import { evolutionPaths } from "./config"
import { evolutionHash, validateEvolutionCandidate, withEvolutionCandidates, writeEvolutionCandidates, type EvolutionCandidate } from "./candidates"
import { withEvolutionAction } from "./policy"

const workflows = makeRuntime(WorkflowService.Service, WorkflowService.defaultLayer)

function skillPath(root: string, candidate: EvolutionCandidate) {
  return path.join(path.resolve(root), ".mendcode", "skills", `evo-${candidate.name.slice(0,16)}-${candidate.id}`, "SKILL.md")
}

async function checkSkillParents(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.dirname(file))
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill destination escapes project")
  let current = path.resolve(root)
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill destination must not contain symlinks")
  }
}

async function saveWorkflow(candidate: EvolutionCandidate, definitionID: string, expectedRevision: number, root: string, saved: boolean) {
  const plan = WorkflowPlan.zod.parse(JSON.parse(candidate.content)) as WorkflowPlan
  return WithInstance.provide({ directory: root, fn: () => workflows.runPromise((service) => service.save({
    plan, definitionID: WorkflowDefinitionID.make(definitionID), expectedRevision, saved, source: "session-generated",
  })) })
}

export async function promoteEvolutionCandidate(root: string, id: string, expectedHash: string, dataDir?: string) {
  return withEvolutionCandidates(root, async (entries) => {
    const candidate = entries.find((item) => item.id === id)
    if (!candidate || candidate.status !== "pending" || candidate.hash !== expectedHash) throw new Error("Candidate changed; review again")
    const reviewed = validateEvolutionCandidate({ kind: candidate.kind, name: candidate.name, description: candidate.description, content: candidate.content, evidenceIDs: candidate.evidenceIDs })
    if (evolutionHash(reviewed) !== expectedHash) throw new Error("Candidate content changed; review again")
    return withEvolutionAction(root, "promote", candidate.revision, async () => {
      const target = candidate.kind === "skill" ? skillPath(root, candidate) : WorkflowDefinitionID.make()
      const body = candidate.kind === "skill"
        ? `---\nname: ${JSON.stringify(path.basename(path.dirname(target)))}\ndescription: ${JSON.stringify(candidate.description)}\n---\n\n${candidate.content}\n`
        : candidate.content
      if (candidate.kind === "skill") {
        await checkSkillParents(root, target)
        const exists = await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error })
        if (exists) throw new Error("Skill destination exists; nothing was overwritten")
      }
      // Write-ahead receipt: interrupted activation remains visible and reversible.
      candidate.receipt = { kind: candidate.kind, target, hash: evolutionHash(body), ...(candidate.kind === "workflow" ? { revision: 1 } : {}) }
      candidate.status = "blocked"
      await writeEvolutionCandidates(root, entries, dataDir)
      if (candidate.kind === "skill") {
        const temporary = path.join(path.dirname(target), `${candidate.id}.tmp`)
        await writeFile(temporary, body, { flag: "wx", mode: 0o600 })
        try { await link(temporary, target) } finally { await unlink(temporary) }
      } else await saveWorkflow(candidate, target, 0, root, true)
      candidate.status = "active"
      await writeEvolutionCandidates(root, entries, dataDir)
      return candidate
    }, dataDir)
  }, dataDir)
}

export async function rollbackEvolutionCandidate(root: string, id: string, expectedHash: string, dataDir?: string) {
  // Explicit rollback is available even after Off; it does not generate or promote anything.
  return withEvolutionCandidates(root, async (entries) => {
    const candidate = entries.find((item) => item.id === id)
    if (!candidate?.receipt || !["active", "blocked"].includes(candidate.status) || candidate.hash !== expectedHash) throw new Error("No matching promotion receipt")
    if (candidate.kind === "skill") {
      const file = skillPath(root, candidate)
      if (candidate.receipt.target !== file) throw new Error("Invalid promotion target")
      await checkSkillParents(root, file)
      if ((await lstat(file)).isSymbolicLink()) throw new Error("Skill target changed")
      if (evolutionHash(await readFile(file, "utf8")) !== candidate.receipt.hash) throw new Error("Skill changed after promotion; manual review required")
      const archive = path.join(evolutionPaths(root, dataDir).projectDir, "retired", candidate.id)
      await mkdir(archive, { recursive: true, mode: 0o700 })
      await rename(file, path.join(archive, "SKILL.md"))
    } else {
      await saveWorkflow(candidate, candidate.receipt.target, candidate.receipt.revision!, root, false)
    }
    candidate.status = "rolled_back"
    await writeEvolutionCandidates(root, entries, dataDir)
    return candidate
  }, dataDir)
}

export async function rejectEvolutionCandidate(root: string, id: string, expectedHash: string, dataDir?: string) {
  return withEvolutionCandidates(root, async (entries) => {
    const candidate = entries.find((item) => item.id === id)
    if (!candidate || candidate.hash !== expectedHash || candidate.status !== "pending") throw new Error("Candidate changed")
    candidate.status = "rejected"
    await writeEvolutionCandidates(root, entries, dataDir)
    return candidate
  }, dataDir)
}
