export type MendPackageArtifactMap = {
  commands?: string[]
  agents?: string[]
  modes?: string[]
  skills?: string[]
  plugins?: string[]
  prompts?: string[]
  mcp?: string[]
  tuiProfile?: string
  themes?: string[]
  context?: string[]
  worktreePolicy?: string
  extensions?: string[]
}

export type MendPackageManifest = {
  version: 0
  id: string
  packageVersion?: string
  title?: string
  description?: string
  kind?: "bundle" | "theme" | "prompt-pack" | "skill-pack" | "starter" | string
  channel?: string
  compatibility?: {
    mendcode?: string
    runtimePack?: string
  }
  artifacts?: MendPackageArtifactMap
  distribution?: {
    source?: {
      type?: "local" | "github" | "private-git" | "team" | "opencode-settings" | string
      url?: string | null
    }
    trust?: {
      signatureRequired?: boolean
    }
  }
}
