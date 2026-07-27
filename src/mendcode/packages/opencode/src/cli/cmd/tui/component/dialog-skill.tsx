import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { Keybind } from "@/util/keybind"
import { Wildcard } from "@/util/wildcard"
import type { Config, PermissionActionConfig } from "@mendcode/sdk/v2"

type SkillMetadata = {
  source?: string
  scope?: string
  enabled?: boolean
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

function scopeCategory(scope?: string) {
  if (scope === "global") return "Global"
  if (scope === "project") return "Project"
  if (scope === "configured") return "Configured"
  if (scope === "remote") return "Remote"
  return "Session"
}

function scopeLabel(scope?: string) {
  if (scope === "project") return "project"
  if (scope === "global") return "global"
  if (scope === "configured") return "configured"
  if (scope === "remote") return "remote"
  return "session"
}

function freshness(updatedAt: unknown) {
  if (typeof updatedAt !== "number" || !updatedAt) return
  if (Date.now() - updatedAt > 60_000) return
  return "updated just now"
}

function configuredSkillAction(config: Config | undefined, name: string): PermissionActionConfig | undefined {
  const permission = config?.permission
  if (!permission || typeof permission === "string") return permission

  const rule = permission.skill
  if (!rule || typeof rule === "string") return rule
  return Wildcard.all(name, rule)
}

function isSkillEnabled(skill: SkillMetadata & { name: string }, config: Config | undefined) {
  if (skill.enabled === false) return false
  return configuredSkillAction(config, skill.name) !== "deny"
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Could not update skill configuration."
}

export function DialogSkill() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  dialog.setSize("large")

  const [pending, setPending] = createSignal<string>()
  const [skills, { refetch: refetchSkills }] = createResource(async () => {
    try {
      const result = await sdk.client.app.skills()
      return result.data ?? []
    } catch {
      return []
    }
  })
  const [config, { refetch: refetchConfig }] = createResource(async () => {
    try {
      const result = await sdk.client.config.get()
      return result.data
    } catch {
      return undefined
    }
  })

  const unsubscribe = sdk.event.on("event", (evt) => {
    const type = (evt.payload as { type?: string } | undefined)?.type
    if (type !== "skill.updated" && type !== "server.connected") return
    void refetchSkills()
    void refetchConfig()
  })
  onCleanup(unsubscribe)

  const list = createMemo(() => (skills() ?? []).toSorted((a, b) => a.name.localeCompare(b.name)))

  async function toggleSkill(name: string, enabled: boolean) {
    if (pending()) return
    setPending(name)
    try {
      const result = await sdk.client.config.update({
        config: {
          permission: {
            skill: { [name]: enabled ? "allow" : "deny" },
          },
        },
      })
      if (result.error) throw result.error
      await Promise.all([refetchSkills(), refetchConfig()])
      toast.show({
        variant: "success",
        message: `${name} ${enabled ? "activated" : "deactivated"} for this project.`,
        duration: 2500,
      })
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setPending(undefined)
    }
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const currentConfig = config()
    const currentPending = pending()
    const entries = list()
    const maxWidth = Math.max(0, ...entries.map((s) => s.name.length))
    return entries.map((skill) => {
      const meta = skill as typeof skill & SkillMetadata
      const enabled = isSkillEnabled(skill, currentConfig)
      const saving = currentPending === skill.name
      return {
        title: `${enabled ? "[on]" : "[off]"} ${skill.name.padEnd(maxWidth)}  ${sourceBadge(meta.source)}`,
        description: [scopeLabel(meta.scope), enabled ? "active" : "disabled", freshness(meta.updatedAt), skill.description?.replace(/\s+/g, " ").trim()]
          .filter((item): item is string => !!item)
          .join(" · "),
        value: skill.name,
        category: scopeCategory(meta.scope),
        footer: saving ? "saving..." : enabled ? "space: deactivate" : "space: activate",
        onSelect: saving ? undefined : () => void toggleSkill(skill.name, !enabled),
      }
    })
  })

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: "toggle",
      disabled: pending() !== undefined,
      onTrigger: (option: DialogSelectOption<string>) => {
        const skill = list().find((item) => item.name === option.value)
        if (!skill) return
        const enabled = isSkillEnabled(skill, config())
        void toggleSkill(skill.name, !enabled)
      },
    },
  ])

  return (
    <DialogSelect
      title={skills.loading || config.loading ? "Skills · loading" : `Skills (${list().length})`}
      placeholder="Search skills..."
      options={options()}
      keybind={keybinds()}
      onSelect={() => {
        // Enter toggles the selected skill; Escape closes the manager.
      }}
    />
  )
}
