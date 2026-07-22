import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo, onCleanup } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

type SkillMetadata = {
  source?: string
  updatedAt?: number
}

function sourceBadge(source?: string) {
  if (source === "mendcode") return "MendCode"
  if (source === "compat-opencode") return ".opencode"
  if (source === "agents") return ".agents"
  if (source === "claude") return ".claude"
  if (source === "config-path") return "Config path"
  if (source === "remote") return "Remote"
  return "Other"
}

function sourceCategory(source?: string) {
  if (source === "mendcode") return "MendCode Skills"
  if (source === "compat-opencode") return "Compatibility Skills"
  if (source === "agents" || source === "claude") return "Shared Local Skills"
  if (source === "config-path") return "Configured Skills"
  if (source === "remote") return "Remote Skills"
  return "Other Skills"
}

function freshness(updatedAt?: number) {
  if (!updatedAt) return
  if (Date.now() - updatedAt > 60_000) return
  return "updated just now"
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  dialog.setSize("large")

  const [skills, { refetch }] = createResource(async () => {
    try {
      const result = await sdk.client.app.skills()
      return result.data ?? []
    } catch {
      return []
    }
  })

  const unsubscribe = sdk.event.on("event", (evt) => {
    const type = (evt.payload as { type?: string } | undefined)?.type
    if (type === "skill.updated") void refetch()
  })
  onCleanup(unsubscribe)

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const meta = skill as typeof skill & SkillMetadata
      return {
        title: `${skill.name.padEnd(maxWidth)}  ${sourceBadge(meta.source)}`,
        description: [freshness(meta.updatedAt), skill.description?.replace(/\s+/g, " ").trim()]
          .filter((item): item is string => !!item)
          .join(" · "),
        value: skill.name,
        category: sourceCategory(meta.source),
        onSelect: () => {
          props.onSelect(skill.name)
          dialog.clear()
        },
      }
    })
  })

  return <DialogSelect title="Skills" placeholder="Search skills..." options={options()} />
}
