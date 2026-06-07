import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useMendTuiProfile } from "@tui/context/mend"
import { useToast } from "@tui/ui/toast"
import { markSetupStepComplete } from "@/mend/setup/state"
import {
  applyTuiSurfaceDraft,
  applyTuiSurfaceDraftPatch,
  resetTuiSurfaceDraft,
  restoreLatestTuiSurfaceHistory,
  restoreTuiSurfaceDraft,
  type TuiSurfaceWorkspace,
} from "@/mend/tui/profile-actions"
import { runTuiHelperEdit, type TuiHelperEditTarget } from "@/mend/tui/helper-edit"
import { SetupActionBar } from "./action-bar"
import { SetupHelperChat, type SetupHelperChatRef } from "./helper-chat"
import { SetupPreviewPane } from "./preview-pane"

export type TuiProfileStepRef = {
  helperFocused: boolean
  focusHelper(): void
  blurHelper(): void
  submitHelper(): void
}

type DraftSnapshot = {
  homeAscii: string
  sessionAscii: string
}

export function TuiProfileStep(props: {
  wide: boolean
  active?: TuiSurfaceWorkspace
  draft?: TuiSurfaceWorkspace
  onReload: () => void
  onFullscreen: () => void
  ref?: (ref: TuiProfileStepRef | undefined) => void
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const toast = useToast()
  const [target, setTarget] = createSignal<TuiHelperEditTarget>("home")
  const [helperRef, setHelperRef] = createSignal<SetupHelperChatRef>()
  const [undoStack, setUndoStack] = createSignal<DraftSnapshot[]>([])
  const [lastEdit, setLastEdit] = createSignal<string>()

  const draftChanged = createMemo(() => {
    const active = props.active
    const draft = props.draft
    if (!active || !draft) return false
    return active.homeAscii.trimEnd() !== draft.homeAscii.trimEnd() || active.sessionAscii.trimEnd() !== draft.sessionAscii.trimEnd()
  })

  const snapshot = (): DraftSnapshot | undefined => {
    const draft = props.draft
    if (!draft) return
    return {
      homeAscii: draft.homeAscii,
      sessionAscii: draft.sessionAscii,
    }
  }

  const markTuiComplete = async () => {
    await markSetupStepComplete("tui", mend.root)
    props.onReload()
  }

  const applyDraftEdit = async () => {
    await applyTuiSurfaceDraft(mend.root)
    setUndoStack([])
    setLastEdit("applied")
    await mend.reload()
    await markTuiComplete()
    toast.show({ variant: "success", message: "Draft applied to active TUI surfaces.", duration: 3000 })
  }

  const discardDraftEdit = async () => {
    await resetTuiSurfaceDraft(mend.root)
    setUndoStack([])
    setLastEdit("discarded")
    props.onReload()
    toast.show({ variant: "success", message: "Draft discarded.", duration: 3000 })
  }

  const undoDraftEdit = async () => {
    const stack = undoStack()
    const previous = stack.at(-1)
    if (!previous) return
    await restoreTuiSurfaceDraft(previous, mend.root)
    setUndoStack(stack.slice(0, -1))
    setLastEdit("undone")
    props.onReload()
    toast.show({ variant: "success", message: "Draft edit undone.", duration: 3000 })
  }

  const restoreAppliedEdit = async () => {
    try {
      await restoreLatestTuiSurfaceHistory(mend.root)
      setUndoStack([])
      setLastEdit("restored")
      await mend.reload()
      props.onReload()
      toast.show({ variant: "success", message: "Restored previous applied TUI surfaces.", duration: 3000 })
    } catch (error) {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : "No applied TUI surface history found.", duration: 4000 })
    }
  }

  const submitHelper = async (instruction: string, editTarget: TuiHelperEditTarget) => {
    const before = snapshot()
    const result = await runTuiHelperEdit({ instruction, target: editTarget, root: mend.root })
    if (!result.ok || result.status !== "applied" || !result.changed || !result.patch) {
      setLastEdit(result.status)
      return {
        status: result.status,
        changed: false,
        diagnostics: result.diagnostics,
        model: result.model,
      }
    }

    if (result.patch.pluginSource) {
      setLastEdit("unsupported-patch")
      return {
        status: "unsupported-patch",
        changed: false,
        diagnostics: ["Helper returned pluginSource; custom draft plugin application is tracked as residual."],
        model: result.model,
      }
    }

    if (!result.patch.homeAscii && !result.patch.sessionAscii) {
      setLastEdit("unsupported-patch")
      return {
        status: "unsupported-patch",
        changed: false,
        diagnostics: ["Helper returned only profile changes; profile draft application is not wired yet."],
        model: result.model,
      }
    }

    const applied = await applyTuiSurfaceDraftPatch(
      {
        homeAscii: result.patch.homeAscii,
        sessionAscii: result.patch.sessionAscii,
      },
      mend.root,
    )
    if (applied.check.exitCode !== 0) {
      setLastEdit("build-failed")
      return {
        status: "build-failed",
        changed: false,
        diagnostics: [applied.check.stderr || applied.check.stdout || "Generated TUI surface plugin failed to build."],
        model: result.model,
      }
    }

    if (before) setUndoStack((items) => [...items, before].slice(-20))
    setLastEdit(`draft · ${result.model || "helper"}`)
    props.onReload()
    await markSetupStepComplete("tui", mend.root)
    return {
      status: result.status,
      changed: true,
      diagnostics: result.diagnostics,
      model: result.model,
    }
  }

  const stepRef: TuiProfileStepRef = {
    get helperFocused() {
      return helperRef()?.focused ?? false
    },
    focusHelper() {
      helperRef()?.focus()
    },
    blurHelper() {
      helperRef()?.blur()
    },
    submitHelper() {
      helperRef()?.submit()
    },
  }
  createEffect(() => {
    props.ref?.(stepRef)
  })
  onCleanup(() => props.ref?.(undefined))

  if (!props.wide) {
    return (
      <box flexDirection="column" gap={1}>
        <text fg={theme.primary}>TUI Profile</text>
        <text fg={theme.textMuted}>Widen the terminal for the Helper editor and real preview panes.</text>
        <SetupActionBar
          actions={[
            { label: "Apply Draft", active: true, disabled: !draftChanged(), onPress: () => void applyDraftEdit() },
            { label: "Discard Draft", disabled: !draftChanged(), onPress: () => void discardDraftEdit() },
            { label: "Restore Applied", onPress: () => void restoreAppliedEdit() },
            { label: "Fullscreen Preview", onPress: props.onFullscreen },
          ]}
        />
      </box>
    )
  }

  return (
    <box flexDirection="row" gap={2} height="100%" minHeight={0}>
      <box flexDirection="column" width="50%" minWidth={0} minHeight={0} borderColor={theme.border} borderStyle="single" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <SetupHelperChat target={target()} lastEdit={lastEdit()} ref={setHelperRef} onSubmit={submitHelper} />
        <box height={1} flexShrink={0} />
        <SetupActionBar
          actions={[
            { label: "Send", active: true, onPress: () => helperRef()?.submit() },
            { label: "Apply Draft", active: true, disabled: !draftChanged(), onPress: () => void applyDraftEdit() },
            { label: "Discard Draft", disabled: !draftChanged(), onPress: () => void discardDraftEdit() },
            { label: "Undo Draft", disabled: undoStack().length === 0, onPress: () => void undoDraftEdit() },
            { label: "Restore Applied", onPress: () => void restoreAppliedEdit() },
            { label: "Fullscreen Preview", onPress: props.onFullscreen },
          ]}
        />
        <box flexShrink={0} paddingTop={1}>
          <text fg={theme.textMuted}>Draft workspace only. Active TUI changes after Apply.</text>
        </box>
      </box>
      <SetupPreviewPane
        target={target()}
        active={props.active}
        draft={props.draft}
        draftChanged={draftChanged()}
        onTargetChange={setTarget}
        onFullscreen={props.onFullscreen}
      />
    </box>
  )
}
