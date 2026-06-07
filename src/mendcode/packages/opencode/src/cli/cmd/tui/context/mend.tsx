import type { MendTuiProfile } from "@/mend/profile"
import { loadMendTuiProfile } from "@/mend/profile"
import { readPromptMode, type MendPromptMode } from "@/mend/prompt/mode"
import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"

type MendTuiProfileContext = {
  profile: MendTuiProfile
  promptMode: MendPromptMode
  root: string
  defaultPath: string
  activePath: string
  reload: () => Promise<MendTuiProfile>
}

const Context = createContext<MendTuiProfileContext>()

export function useMendTuiProfile() {
  const value = useContext(Context)
  if (!value) throw new Error("useMendTuiProfile must be used within MendTuiProfileProvider")
  return value
}

export function MendTuiProfileProvider(
  props: ParentProps<{
    profile: MendTuiProfile
    root: string
    defaultPath: string
    activePath: string
    config?: unknown
  }>,
) {
  const [profile, setProfile] = createSignal(props.profile)
  const [promptMode, setPromptMode] = createSignal<MendPromptMode>("focus")
  const refreshPromptMode = () => void readPromptMode(props.root).then((state) => setPromptMode(state.mode))
  refreshPromptMode()
  const promptModeRefresh = setInterval(refreshPromptMode, 1000)
  onCleanup(() => clearInterval(promptModeRefresh))
  const value: MendTuiProfileContext = {
    get profile() {
      return profile()
    },
    get promptMode() {
      return promptMode()
    },
    root: props.root,
    defaultPath: props.defaultPath,
    activePath: props.activePath,
    reload: async () => {
      const [next, prompt] = await Promise.all([loadMendTuiProfile(props.root, props.config), readPromptMode(props.root)])
      setProfile(next.profile)
      setPromptMode(prompt.mode)
      return next.profile
    },
  }
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
