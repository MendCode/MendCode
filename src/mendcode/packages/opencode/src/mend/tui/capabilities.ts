import { allowsCapability, type MendCapabilityStatus, type MendTrustTier } from "./trust"

export const MEND_TUI_CAPABILITY_CONTRACT_VERSION = "2.0.0"

export type MendCustomizationEntrypoint =
  | "runtime"
  | "setup"
  | "prompt.full"
  | "status"
  | "help"
  | "plugin"
  | "legacy.ascii"

export type MendCapabilityTier = "public-safe" | "trusted-only" | "experimental" | "blocked"

export type MendCapabilityPublicID =
  | "home.logo"
  | "home.prompt"
  | "home.prompt.right"
  | "home.bottom"
  | "home.footer"
  | "sidebar.title"
  | "sidebar.content"
  | "sidebar.footer"
  | "editor.widget.above"
  | "editor.widget.below"
  | "footer.entry"
  | "footer.replace"
  | "workingIndicator.frames"
  | "workingIndicator.visibility"
  | "session.prompt.visual"
  | "session.prompt.right"
  | "session.prompt.fullEditor"
  | "setup.route"
  | "theme.install"
  | "prompt.full.capability-awareness"
  | "prompt.full.safe-routing"
  | "transcript.renderers"
  | "prompt.parser.override"
  | "sync.bootstrap.override"

export type MendCapabilityLegacyID =
  | "status"
  | "widget.aboveEditor"
  | "widget.belowEditor"
  | "footer.augment"
  | "editor.custom"
  | "slot.home_logo"
  | "slot.home_footer"
  | "slot.sidebar_content"
  | "route.setup"

export type MendCapabilityID = MendCapabilityPublicID | MendCapabilityLegacyID

export type MendCapabilityOperation =
  | "replace"
  | "augment"
  | "setWidget"
  | "setIndicator"
  | "setVisualTheme"
  | "setEditorFactory"
  | "inspect"
  | "blocked"

export type MendCapability = {
  id: MendCapabilityPublicID
  label: string
  productSurface: string
  runtimeIDs: string[]
  legacyIDs: MendCapabilityLegacyID[]
  trust: MendTrustTier
  status: MendCapabilityStatus
  tier: MendCapabilityTier
  owner: string
  fallback: string
  docs: string
  entrypoints: MendCustomizationEntrypoint[]
  operations: MendCapabilityOperation[]
  contractVersion: string
  mapsFromUserIntents: string[]
  nearestSafeAlternatives: MendCapabilityPublicID[]
  migrationHints?: string[]
}

export type MendCustomizationResolution = {
  status: "resolved" | "clarify" | "blocked" | "unknown"
  request: string
  surface: MendCapabilityPublicID | null
  label: string | null
  operation: MendCapabilityOperation | null
  reason: string
  alternatives: MendCapabilityPublicID[]
}

const registry = [
  {
    id: "home.logo",
    label: "Home logo",
    productSurface: "home logo",
    runtimeIDs: ["home_logo"],
    legacyIDs: ["slot.home_logo"],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the product default logo and title treatment.",
    docs: "Public slot for replacing the home identity surface without touching prompt internals.",
    entrypoints: ["runtime", "setup", "prompt.full", "status", "help", "plugin", "legacy.ascii"],
    operations: ["replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["logo", "home logo", "terminal brand", "product title"],
    nearestSafeAlternatives: ["home.bottom", "sidebar.title"],
    migrationHints: ["Legacy home.ascii maps here first."],
  },
  {
    id: "home.prompt",
    label: "Home prompt",
    productSurface: "home prompt",
    runtimeIDs: ["home_prompt"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "cli/cmd/tui/routes/home",
    fallback: "Render the default shared Prompt component.",
    docs: "Replace the entire home prompt host only when a host-managed prompt surface is required.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["home prompt", "new chat input", "landing prompt"],
    nearestSafeAlternatives: ["home.prompt.right", "session.prompt.visual"],
  },
  {
    id: "home.prompt.right",
    label: "Home prompt right surface",
    productSurface: "home prompt right",
    runtimeIDs: ["home_prompt_right"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the host prompt row metadata empty or host-owned.",
    docs: "Auxiliary status/info area next to the home prompt.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["home prompt badge", "home prompt status", "home prompt right"],
    nearestSafeAlternatives: ["home.bottom", "footer.entry"],
  },
  {
    id: "home.bottom",
    label: "Home bottom widgets",
    productSurface: "home bottom",
    runtimeIDs: ["home_bottom"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the default home widget row.",
    docs: "Safe-first slot under the home prompt for helper content and simple widgets.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["augment", "replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["home widget", "welcome panel", "bottom panel"],
    nearestSafeAlternatives: ["home.footer", "sidebar.content"],
  },
  {
    id: "home.footer",
    label: "Home footer",
    productSurface: "home footer",
    runtimeIDs: ["home_footer"],
    legacyIDs: ["slot.home_footer"],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the default product footer row.",
    docs: "Footer strip on the home screen with product, widgets, and runtime hints.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["replace", "augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["home footer", "landing footer", "home status strip"],
    nearestSafeAlternatives: ["footer.entry", "sidebar.footer"],
  },
  {
    id: "sidebar.title",
    label: "Sidebar title",
    productSurface: "sidebar title",
    runtimeIDs: ["sidebar_title"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the default session title/workspace metadata block.",
    docs: "Top title block in the session sidebar.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["replace", "augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["sidebar title", "sidebar header", "session sidebar title"],
    nearestSafeAlternatives: ["sidebar.content", "home.logo"],
  },
  {
    id: "sidebar.content",
    label: "Sidebar content",
    productSurface: "sidebar content",
    runtimeIDs: ["sidebar_content"],
    legacyIDs: ["slot.sidebar_content"],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the default sidebar widgets and Memory block.",
    docs: "Main sidebar panel for widgets, Memory status, and custom stacked content.",
    entrypoints: ["runtime", "setup", "prompt.full", "status", "help", "plugin", "legacy.ascii"],
    operations: ["replace", "augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["sidebar", "sidebar panel", "sidebar widget", "session panel"],
    nearestSafeAlternatives: ["sidebar.footer", "footer.entry", "session.prompt.right"],
    migrationHints: ["Legacy session.ascii currently projects here as a safe compatibility surface."],
  },
  {
    id: "sidebar.footer",
    label: "Sidebar footer",
    productSurface: "sidebar footer",
    runtimeIDs: ["sidebar_footer"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the default version/theme summary.",
    docs: "Bottom strip in the session sidebar.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["replace", "augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["sidebar footer", "sidebar status", "sidebar bottom"],
    nearestSafeAlternatives: ["sidebar.content", "footer.entry"],
  },
  {
    id: "editor.widget.above",
    label: "Editor widget above",
    productSurface: "editor widget above",
    runtimeIDs: ["widget.aboveEditor"],
    legacyIDs: ["widget.aboveEditor"],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/widgets",
    fallback: "Skip the widget and keep the default prompt stack.",
    docs: "Trusted widget contract above the active editor/prompt surface.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["setWidget", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["widget above editor", "panel above chat input", "toolbar above prompt"],
    nearestSafeAlternatives: ["editor.widget.below", "sidebar.content"],
  },
  {
    id: "editor.widget.below",
    label: "Editor widget below",
    productSurface: "editor widget below",
    runtimeIDs: ["widget.belowEditor"],
    legacyIDs: ["widget.belowEditor"],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/widgets",
    fallback: "Skip the widget and keep the default prompt stack.",
    docs: "Trusted widget contract below the active editor/prompt surface.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["setWidget", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["widget below editor", "panel below chat input", "prompt footer widget"],
    nearestSafeAlternatives: ["editor.widget.above", "footer.entry"],
  },
  {
    id: "footer.entry",
    label: "Footer/status entry",
    productSurface: "footer/status entry",
    runtimeIDs: ["status", "footer.augment"],
    legacyIDs: ["status", "footer.augment"],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/status + mend/tui/footer",
    fallback: "Remove only the failing entry and preserve the host footer.",
    docs: "Deterministic entry-level footer/status contract for chips, badges, and small inline runtime metadata.",
    entrypoints: ["runtime", "setup", "prompt.full", "status", "help", "plugin"],
    operations: ["augment", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["status bar", "footer entry", "status chip", "status badge", "footer widget"],
    nearestSafeAlternatives: ["session.prompt.right", "sidebar.content", "home.footer"],
  },
  {
    id: "footer.replace",
    label: "Footer replacement",
    productSurface: "footer replacement",
    runtimeIDs: ["footer.replace"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/footer",
    fallback: "Restore the default footer renderer.",
    docs: "Trusted host-managed footer replacement for cases that exceed entry-level augmentation.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["replace footer", "custom footer", "rewrite status bar"],
    nearestSafeAlternatives: ["footer.entry", "home.footer", "sidebar.footer"],
  },
  {
    id: "workingIndicator.frames",
    label: "Working indicator frames",
    productSurface: "working indicator frames",
    runtimeIDs: ["workingIndicator.frames"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/working-indicator",
    fallback: "Use the default animated blocks spinner.",
    docs: "Trusted control over the visible spinner frames while work is running.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["setIndicator", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["spinner", "loader frames", "working indicator"],
    nearestSafeAlternatives: ["workingIndicator.visibility", "footer.entry"],
  },
  {
    id: "workingIndicator.visibility",
    label: "Working indicator visibility",
    productSurface: "working indicator visibility",
    runtimeIDs: ["workingIndicator.visibility"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/working-indicator",
    fallback: "Use the default loader visibility policy.",
    docs: "Trusted control over whether the host working indicator is shown.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["setIndicator", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["hide spinner", "show loader", "busy indicator"],
    nearestSafeAlternatives: ["workingIndicator.frames", "footer.entry"],
  },
  {
    id: "session.prompt.visual",
    label: "Prompt visual chrome",
    productSurface: "session prompt visual",
    runtimeIDs: ["editor.visual"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/editor-host + cli/cmd/tui/component/prompt",
    fallback: "Keep the default prompt visuals and host-owned submission semantics.",
    docs: "Safe visual-only prompt customization: border glyphs, placeholder policy, and adjacent non-semantic chrome.",
    entrypoints: ["runtime", "setup", "prompt.full", "status", "help", "plugin"],
    operations: ["setVisualTheme", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["chat input border", "prompt border", "placeholder text", "prompt chrome", "input symbols"],
    nearestSafeAlternatives: ["session.prompt.right", "session.prompt.fullEditor"],
  },
  {
    id: "session.prompt.right",
    label: "Prompt right surface",
    productSurface: "session prompt right",
    runtimeIDs: ["session_prompt_right"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/sdk/slots",
    fallback: "Keep the host-owned right-side metadata area empty or default.",
    docs: "Right-side prompt status/info area that stays separate from the parser and submit pipeline.",
    entrypoints: ["runtime", "prompt.full", "status", "help", "plugin"],
    operations: ["augment", "replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["prompt right", "input badge", "chat input status", "inline status"],
    nearestSafeAlternatives: ["footer.entry", "session.prompt.visual"],
  },
  {
    id: "session.prompt.fullEditor",
    label: "Full editor replacement",
    productSurface: "session prompt full editor",
    runtimeIDs: ["editor.custom", "session_prompt", "home_prompt"],
    legacyIDs: ["editor.custom"],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/tui/editor-host",
    fallback: "Fall back to the default Prompt inside the same session.",
    docs: "Trusted host-managed full editor factory that must honor visible/disabled/ref/onSubmit lifecycle contracts.",
    entrypoints: ["runtime", "prompt.full", "status", "plugin"],
    operations: ["setEditorFactory", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["replace editor", "full editor", "vim mode", "modal input", "custom chat editor"],
    nearestSafeAlternatives: ["session.prompt.visual", "session.prompt.right"],
  },
  {
    id: "setup.route",
    label: "Setup route",
    productSurface: "setup customization entrypoint",
    runtimeIDs: ["route.setup"],
    legacyIDs: ["route.setup"],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "cli/cmd/tui/routes/setup",
    fallback: "Navigate to the current MendCode-owned setup route only.",
    docs: "Setup exposes safe categories and points to the broader runtime/plugin/file path when setup is not the owner.",
    entrypoints: ["setup", "prompt.full", "status", "help"],
    operations: ["inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["setup", "configure tui", "customization entrypoint", "onboarding"],
    nearestSafeAlternatives: ["home.logo", "session.prompt.visual"],
  },
  {
    id: "theme.install",
    label: "Theme install",
    productSurface: "theme install",
    runtimeIDs: ["theme.install"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "trusted-only",
    owner: "mend/sdk/theme",
    fallback: "Leave the current theme unchanged.",
    docs: "Theme installation remains host/plugin-managed and does not imply arbitrary TUI source mutation.",
    entrypoints: ["runtime", "setup", "prompt.full", "status", "plugin"],
    operations: ["replace", "inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["theme", "palette", "terminal colors"],
    nearestSafeAlternatives: ["session.prompt.visual", "home.logo"],
  },
  {
    id: "prompt.full.capability-awareness",
    label: "Prompt full capability awareness",
    productSurface: "prompt full capability awareness",
    runtimeIDs: ["prompt.full.capability-awareness"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/prompt/capabilities",
    fallback: "Describe only the verified safe seams and blocked boundaries.",
    docs: "Full mode receives the generated customization contract and examples, not a vague promise of arbitrary Pi-like control.",
    entrypoints: ["prompt.full", "status", "help"],
    operations: ["inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["what can mendcode customize", "pi-like customization", "tui capabilities"],
    nearestSafeAlternatives: ["prompt.full.safe-routing"],
  },
  {
    id: "prompt.full.safe-routing",
    label: "Prompt full safe routing",
    productSurface: "prompt full routing",
    runtimeIDs: ["prompt.full.safe-routing"],
    legacyIDs: [],
    trust: "trusted",
    status: "available",
    tier: "public-safe",
    owner: "mend/prompt/compose",
    fallback: "Prefer the nearest safe MendCode-owned surface and explain blockers explicitly.",
    docs: "Full mode maps vague TUI requests onto named supported surfaces before considering any hot path.",
    entrypoints: ["prompt.full", "status", "help"],
    operations: ["inspect"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["add a widget to the status bar", "change chat input border", "edit the terminal ui"],
    nearestSafeAlternatives: ["footer.entry", "session.prompt.visual", "sidebar.content"],
  },
  {
    id: "transcript.renderers",
    label: "Transcript renderers",
    productSurface: "transcript renderers",
    runtimeIDs: ["transcript.renderers"],
    legacyIDs: [],
    trust: "blocked",
    status: "blocked",
    tier: "blocked",
    owner: "protected-hot-path",
    fallback: "Keep transcript rendering internal to MendCore.",
    docs: "Transcript/message-part renderer takeover stays blocked in v1.",
    entrypoints: ["prompt.full", "status", "help"],
    operations: ["blocked"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["transcript renderer", "message renderer", "chat transcript ui internals"],
    nearestSafeAlternatives: ["sidebar.content", "session.prompt.right", "footer.entry"],
  },
  {
    id: "prompt.parser.override",
    label: "Prompt parser override",
    productSurface: "prompt parser",
    runtimeIDs: ["prompt.parser.override"],
    legacyIDs: [],
    trust: "blocked",
    status: "blocked",
    tier: "blocked",
    owner: "protected-hot-path",
    fallback: "Keep prompt parsing internal to MendCore.",
    docs: "Prompt parser overrides stay blocked in v1.",
    entrypoints: ["prompt.full", "status", "help"],
    operations: ["blocked"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["parser override", "change submit semantics", "replace prompt parser"],
    nearestSafeAlternatives: ["session.prompt.visual", "session.prompt.fullEditor"],
  },
  {
    id: "sync.bootstrap.override",
    label: "Sync/bootstrap override",
    productSurface: "sync/bootstrap",
    runtimeIDs: ["sync.bootstrap.override"],
    legacyIDs: [],
    trust: "blocked",
    status: "blocked",
    tier: "blocked",
    owner: "protected-hot-path",
    fallback: "Keep sync/bootstrap internal to MendCore.",
    docs: "Sync/bootstrap replacement stays blocked in v1.",
    entrypoints: ["prompt.full", "status", "help"],
    operations: ["blocked"],
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    mapsFromUserIntents: ["replace bootstrap", "replace sync", "custom startup lifecycle"],
    nearestSafeAlternatives: ["setup.route", "sidebar.content", "footer.entry"],
  },
] satisfies MendCapability[]

const aliasToPublic = new Map<MendCapabilityID, MendCapabilityPublicID>()
for (const capability of registry) {
  aliasToPublic.set(capability.id, capability.id)
  for (const alias of capability.legacyIDs) aliasToPublic.set(alias, capability.id)
}

function normalizeIntentText(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function containsAny(text: string, list: readonly string[]) {
  return list.some((item) => text.includes(item))
}

function capabilityOrNull(id: MendCapabilityPublicID | null) {
  return id ? getMendCapability(id) : undefined
}

function resolution(
  request: string,
  status: MendCustomizationResolution["status"],
  surface: MendCapabilityPublicID | null,
  operation: MendCapabilityOperation | null,
  reason: string,
  alternatives: MendCapabilityPublicID[] = [],
): MendCustomizationResolution {
  const capability = capabilityOrNull(surface)
  return {
    status,
    request,
    surface,
    label: capability?.label ?? null,
    operation,
    reason,
    alternatives,
  }
}

export function mendTuiCapabilities() {
  return registry
}

export function mendTuiCapabilityVersion() {
  return MEND_TUI_CAPABILITY_CONTRACT_VERSION
}

export function getMendCapability(id: MendCapabilityID) {
  const publicID = aliasToPublic.get(id)
  if (!publicID) return undefined
  return registry.find((item) => item.id === publicID)
}

export function capabilityAllowed(id: MendCapabilityID, trust: MendTrustTier = "trusted") {
  const capability = getMendCapability(id)
  if (!capability) return false
  return allowsCapability(capability.status, trust)
}

export function visibleCustomizationCapabilities() {
  return registry.filter((item) => item.status !== "blocked")
}

export function blockedCustomizationCapabilities() {
  return registry.filter((item) => item.status === "blocked")
}

export function customizationCapabilitySummary() {
  return visibleCustomizationCapabilities()
    .map((item) => `${item.id}: ${item.status} (${item.trust})`)
    .join("\n")
}

export function customizationCapabilitiesForEntrypoint(entrypoint: MendCustomizationEntrypoint) {
  return registry.filter((item) => item.entrypoints.some((registered) => registered === entrypoint))
}

export function resolveCustomizationIntent(request: string): MendCustomizationResolution {
  const text = normalizeIntentText(request)
  if (!text) return resolution(request, "unknown", null, null, "No customization request text was provided.")

  if (containsAny(text, ["transcript renderer", "message renderer", "transcript ui", "render transcript"])) {
    return resolution(
      request,
      "blocked",
      "transcript.renderers",
      "blocked",
      "Transcript renderers remain blocked in v1.",
      ["sidebar.content", "session.prompt.right", "footer.entry"],
    )
  }

  if (containsAny(text, ["parser override", "prompt parser", "change submit semantics", "submission parser"])) {
    return resolution(
      request,
      "blocked",
      "prompt.parser.override",
      "blocked",
      "Prompt parsing and submission semantics remain host-owned in v1.",
      ["session.prompt.visual", "session.prompt.fullEditor"],
    )
  }

  if (containsAny(text, ["bootstrap override", "replace sync", "replace bootstrap", "startup lifecycle"])) {
    return resolution(
      request,
      "blocked",
      "sync.bootstrap.override",
      "blocked",
      "Sync/bootstrap replacement remains blocked in v1.",
      ["setup.route", "sidebar.content", "footer.entry"],
    )
  }

  if (containsAny(text, ["replace editor", "full editor", "modal input", "vim mode", "custom chat editor"])) {
    return resolution(
      request,
      "resolved",
      "session.prompt.fullEditor",
      "setEditorFactory",
      "This request maps to the trusted full editor host contract.",
      ["session.prompt.visual"],
    )
  }

  if (containsAny(text, ["chat input border", "prompt border", "placeholder", "input symbols", "prompt chrome"])) {
    return resolution(
      request,
      "resolved",
      "session.prompt.visual",
      "setVisualTheme",
      "This request maps to the safe visual prompt contract.",
      ["session.prompt.right", "session.prompt.fullEditor"],
    )
  }

  if (containsAny(text, ["status bar"])) {
    if (containsAny(text, ["widget", "badge", "chip", "entry"])) {
      return resolution(
        request,
        "resolved",
        "footer.entry",
        "augment",
        "Status-bar widget requests default to the footer/status entry contract.",
        ["sidebar.content", "session.prompt.right"],
      )
    }
    return resolution(
      request,
      "clarify",
      "footer.entry",
      "augment",
      "“Status bar” can mean footer/status entries, sidebar content, or the prompt-right surface. Default safe route is footer/status entries.",
      ["footer.entry", "sidebar.content", "session.prompt.right"],
    )
  }

  if (containsAny(text, ["prompt right", "input badge", "inline status"])) {
    return resolution(
      request,
      "resolved",
      "session.prompt.right",
      "augment",
      "This request maps to the prompt-right surface.",
      ["footer.entry"],
    )
  }

  if (containsAny(text, ["widget above", "above editor", "above chat input"])) {
    return resolution(request, "resolved", "editor.widget.above", "setWidget", "This request maps to the trusted above-editor widget contract.")
  }

  if (containsAny(text, ["widget below", "below editor", "below chat input"])) {
    return resolution(request, "resolved", "editor.widget.below", "setWidget", "This request maps to the trusted below-editor widget contract.")
  }

  if (containsAny(text, ["footer replace", "replace footer", "custom footer"])) {
    return resolution(request, "resolved", "footer.replace", "replace", "This request maps to the trusted footer replacement contract.", ["footer.entry"])
  }

  if (containsAny(text, ["footer", "status chip", "footer entry"])) {
    return resolution(request, "resolved", "footer.entry", "augment", "This request maps to the footer/status entry contract.", ["footer.replace"])
  }

  if (containsAny(text, ["sidebar footer"])) {
    return resolution(request, "resolved", "sidebar.footer", "replace", "This request maps to the sidebar footer slot.")
  }

  if (containsAny(text, ["sidebar title", "sidebar header"])) {
    return resolution(request, "resolved", "sidebar.title", "replace", "This request maps to the sidebar title slot.")
  }

  if (containsAny(text, ["sidebar", "side panel"])) {
    return resolution(request, "resolved", "sidebar.content", "replace", "This request maps to the sidebar content slot.", ["sidebar.footer"])
  }

  if (containsAny(text, ["home footer"])) {
    return resolution(request, "resolved", "home.footer", "replace", "This request maps to the home footer slot.")
  }

  if (containsAny(text, ["home logo", "terminal brand", "product title", "logo"])) {
    return resolution(request, "resolved", "home.logo", "replace", "This request maps to the home logo/title slot.", ["sidebar.title"])
  }

  if (containsAny(text, ["home prompt"])) {
    return resolution(request, "resolved", "home.prompt", "replace", "This request maps to the home prompt host.", ["home.prompt.right"])
  }

  if (containsAny(text, ["theme", "palette", "terminal colors"])) {
    return resolution(request, "resolved", "theme.install", "replace", "This request maps to the trusted theme install path.", ["session.prompt.visual"])
  }

  if (containsAny(text, ["setup", "configure tui", "customization entrypoint"])) {
    return resolution(request, "resolved", "setup.route", "inspect", "This request maps to setup as a capability-driven entrypoint.")
  }

  return resolution(
    request,
    "unknown",
    null,
    null,
    "No named MendCode customization surface matched this request yet.",
    ["footer.entry", "sidebar.content", "session.prompt.visual"],
  )
}
