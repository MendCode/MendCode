/**
 * The zod-free half of the protocol for thin clients ("@mendcode/protocol/wire").
 *
 * Loading zod and every schema costs a terminal client ~35 MB of RSS for validating frames that come
 * from its own local daemon, which already validates everything it accepts (commands are checked with
 * the full schemas there). Clients therefore decode with structural checks only; the daemon keeps the
 * strict schemas. Types still come from the schema modules (type-only imports are erased).
 */
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./constants"
export { estimateTokens } from "./constants"
export { usageContext, type UsageContextInput } from "./usage-context"
export * from "./context-forecast"
export * from "./backlog-data"
export { claudeFastModel, findModel } from "./model-lookup"
export { clampWindow, modelContextOf, modelRef, MODEL_CONTEXT_LIMIT, MODEL_CONTEXT_RANGE, type ModelContextEntry } from "./model-context"
import type { Frame } from "./frames"
export type { ComputerCaptureInput, ComputerKeyInput, ComputerCaptureMetadata, ComputerCaptureReport, ComputerKeyReport } from "./computer"
export type { ComputerSessionInput, ComputerObserveInput, ComputerCodeInput, ComputerTarget, ComputerNode, ComputerSessionReport, ComputerObservation, ComputerCodeReport } from "./computer-session"
export { graftReportedSavings } from "./graft-savings"
export { layoutAttachments, attachmentOrder, attachmentPlacementProblem, pastedText, inlineTexts, MAX_ATTACHMENT_LABEL, type LayoutPart, type PlacedRef } from "./attachment-layout"
export { setupImportKey, type SetupImportKeyParts } from "./setup-import-data"
export { QUOTA_REFRESH_PROVIDERS, QUOTA_REFRESH_MIN_MINUTES, QUOTA_REFRESH_DEFAULT_MINUTES, QUOTA_REFRESH_COST, QUOTA_REFRESH_CLAUDE, normalizeQuotaRefresh, quotaRefreshIntervalMs, quotaRefreshProblems, quotaRefreshText, type QuotaRefreshEntry, type QuotaRefreshProvider } from "./quota-refresh-data"
export { FOOTER_ROWS_MAX, FOOTER_ROW_SEGMENTS_MAX, FOOTER_HEIGHT_FRACTION, FOOTER_ICON_MODES, FOOTER_PRESETS, FOOTER_PRESET_NAMES, FOOTER_TEXT_MAX_ENTRIES, FOOTER_TEXT_MAX_CHARS, footerRowsProblems, footerSegmentProblem, footerTextLine, footerTextProblems, parseRowSegment, type FooterIconMode, type FooterPreset } from "./footer-rows-data"
export { PROMPT_MODES, PROMPT_FAMILIES, PROMPT_FOCUS_CHOICES, promptFocusLabel, promptCostLine, promptCostWarning, promptCostOf, type PromptModeCost, type PromptMode, type PromptFamily, type PromptFocusChoice, type PromptFocus, type PromptStatus, type PromptBuildReport } from "./prompt-data"
export { TUI_DEFAULTS, TUI_ENUMS, TUI_OPERATIONS, ACTIVITY_PARTS, ACTIVITY_PARTS_DEFAULT, unknownActivityParts, STAT_PART_IDS, unknownStatParts, type StatPartId, tuiProblems, type ActivityPart, type TuiOperation, type TuiControlInput, type TuiControlReport } from "./tui-data"
export { TIERS, TIER_BUNDLES, TIER_BASELINE_TOKENS, MINIMALIST_SLASH, slashTier, FEATURES, FEATURE_IDS, tierIncludes, featureState, featureOn, effectiveSettings, tierRows, tierDiff, isTier, isFeatureId, type Tier, type TierBundle, type FeatureId, type FeatureSpec, type FeatureState, type TierRow, type TierSettings } from "./tier-data"

export { assembleSchema, createSchemaCatalog, SCHEMA_PAGE_BYTES, SCHEMA_MAX_PAGES, type SchemaCatalog, type SchemaIndex, type SchemaIndexEntry, type SchemaPage } from "./schema-catalog"
export { isLoopbackHost,parseRemoteAddress, isReadOnlyCommand, READ_ONLY_COMMANDS } from "./remote"
export { AGENT_OPEN_COMMANDS, AGENT_CAPPED_COMMANDS, AGENT_ORIGIN_CAPABILITY, AGENT_LIMIT_CAPABILITY, AGENT_SHELL_ENV, AGENT_SHELL_FILE_BLOCKS, agentCommandClass, agentRefusal, capPermission, permissionRank, type AgentCommandClass } from "./agent-origin"
export { approvalRuleOffer, withApprovalRules, type ApprovalRule, type ApprovalRuleOffer, type ApprovalRuleLevel } from "./approval-rule"

export { createIdFactory, ID_PREFIXES } from "./id-factory"
export { DEFAULT_PROFILE, PROFILE_NAME, profileFor, type ProfileRule } from "./profiles"
export { findSecrets, redactEventText, redactSecrets, replaceSecretMarkers, replaceSecrets, secretMarker, type Redaction, type SecretFinding } from "./redact"
export { DEFAULT_IDLE_COMPACT_AT_TOKENS, IDLE_COMPACT_MARGIN_MS, ANTHROPIC_CACHE_LIFETIME_MS, OPENAI_CACHE_LIFETIME_MS, CHATGPT_CACHE_LIFETIME_MS, ANTHROPIC_CACHE_LIFETIME_1H_MS, CACHE_TTLS, CACHE_TTL_PROVIDER_TYPES, WAIT_CACHE_AFTER, nextWaitCache, type CacheTtl, type WaitCacheState, CACHE_LIFETIME_MINUTES_RANGE, IDLE_COMPACT_OFF_REASONS, IDLE_COMPACT_NOTE, cacheLifetime, type CacheLifetime, type CacheLifetimeSource, type IdleCompactOffReason } from "./idle-compaction-data"
export {
  DEFAULT_COMPACT_AT_TOKENS,
  DEFAULT_FOOTER,
  EXPERIMENTAL_FLAGS,
  FOOTER_OPT_IN,
  FOOTER_SEGMENTS,
  FOOTER_STATS,
  GOAL_INLINE_OBJECTIVE_CHARS,
  GOAL_MAX_OBJECTIVE_CHARS,
  GOAL_MAX_TOKEN_BUDGET,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
  MAX_DRAFT_CHARS,
  TEXT_PUT_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  MAX_FRAME_BYTES,
  MODEL_ROLES,
  OUTPUT_STYLES,
  PROTOCOL_VERSION,
  REASONING_EFFORTS,
  SERVICE_TIERS,
  SESSION_COLORS,
  type SessionColor,
  type ExperimentalFlag,
  type FooterSegment,
  type GoalStatus,
  type ModelRole,
  type OutputStyle,
  type ReasoningEffort,
  type ServiceTier,
} from "./constants"

export { PACKAGE_SELECTIONS, type PackageSelection } from "./package-authoring-data"
export { PACKAGE_KINDS, PACKAGE_META_ENTRIES, PACKAGE_READ_PATHS, EXECUTABLE_PACKAGE_PATHS, SWITCHABLE_KINDS, exportPathsFor, unknownPackageEntries, type PackageKindId, type PackageKindSpec } from "./package-kinds"
export { versionSatisfies, versionRangeProblem, compatibilityProblem, parseVersion } from "./version-range"
export {
  ACTIVATION_KEYS, ACTIVATION_PROMPT_FILES, ACTIVATION_PANEL_PRESETS, ACTIVATION_DENIED_PROFILE_KEYS, ACTIVATION_FORBIDDEN_MESSAGE, ACTIVATION_STATE_FILE, ACTIVATION_MAX_BYTES, EMPTY_ACTIVATION_STATE,
  activationProblems, activationProfile, activationStateJson, describeChanges, hasLook, keptKey, lookOwner, moduleStem, parseActivationState, resolveActivation, saveLook,
  type Activation, type ActivationPackage, type ActivationResult, type ActivationScope, type ActivationState, type OverrideRow, type ProfileOrigin, type SavedLook, type WaitingLook,
} from "./activation-data"

export {
  PRECEDENCE_SURFACES, PRECEDENCE_MODE, PRECEDENCE_LABELS, conflictRows, describePrecedence, resolvePrecedence,
  type PrecedenceClaim, type PrecedenceEntry, type PrecedenceFacts, type PrecedenceRow, type PrecedenceSurface,
} from "./precedence-data"

export type TrustedDecode = { ok: true; frame: Frame } | { ok: false; error: string }

const KINDS = new Set(["auth", "command", "event", "global", "ack", "error"])

/** Size, JSON, version and envelope-shape checks; the body is trusted to match its kind. */
export function decodeTrustedFrame(line: string): TrustedDecode {
  if (line.length > MAX_FRAME_BYTES || Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return { ok: false, error: "[PROTOCOL]: frame exceeds MAX_FRAME_BYTES" }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false, error: "[PROTOCOL]: frame is not valid JSON" }
  }
  if (typeof json !== "object" || json === null) return { ok: false, error: "[PROTOCOL]: frame is not an object" }
  const frame = json as { v?: unknown; kind?: unknown; body?: unknown; id?: unknown }
  if (frame.v !== PROTOCOL_VERSION) return { ok: false, error: "[PROTOCOL]: unsupported frame version" }
  if (typeof frame.kind !== "string" || !KINDS.has(frame.kind)) return { ok: false, error: "[PROTOCOL]: unknown frame kind" }
  if ((frame.kind === "event" || frame.kind === "global" || frame.kind === "command") && (typeof frame.body !== "object" || frame.body === null))
    return { ok: false, error: "[PROTOCOL]: frame without body" }
  if (frame.kind === "auth" && (typeof frame.id !== "string" || typeof (json as { token?: unknown }).token !== "string")) return { ok: false, error: "[PROTOCOL]: invalid auth frame" }
  if (frame.kind === "ack" && typeof frame.id !== "string") return { ok: false, error: "[PROTOCOL]: ack without id" }
  return { ok: true, frame: json as Frame }
}

export function encodeFrame(frame: Frame) {
  return `${JSON.stringify(frame)}\n`
}

export * from "./app-server"
export type { LspInput, LspOperation, LspReport } from "./lsp"
export * from "./review-data"
export type { FormatterFileReport, FormatterStatusReport } from "./formatter"
export { THEME_NAME, MAX_THEME_BYTES, THEME_REQUIRED_ROLES, V1_THEME_ROLES, MARKDOWN_COLOR_ROLES, MARKDOWN_BORDER_ROLES, OVERRIDABLE_COLOR_ROLES, parseMarkdownColors, themeDocument, type ThemeDocument } from "./theme-data"
export { AGENT_CREATE_PERMISSIONS, AGENT_CREATE_NAME, agentName } from "./agent-data"

export * from "./project-data"
export { adaptiveBounds } from "./loop-wire"
export { projectMessageEvent, revisedEvents } from "./message-projection"

export type { BudgetPolicy, BudgetPrice, BudgetReport, SetupReport, SetupPreset } from "./setup"
export { RELEASE_CHANNELS, type ReleaseChannel, type ReleaseReport } from "./release-data"
export { USAGE_WIDGET_IDS, normalizeUsageWidgets, type UsageWidgetId } from "./usage-widget-data"
export * from "./github-data"
export * from "./git-commit-data"
export * from "./git-actions-data"
export * from "./git-init-data"
export * from "./codegraph-overview-data"
export * from "./quota-data"

export { FILE_VIEW_MAX_BYTES, FILE_VIEW_MAX_ROWS, FILE_VIEW_MAX_LINE, FILE_VIEW_MAX_HITS, FILE_VIEW_MAX_REPLY_BYTES, FILE_VIEW_MAX_ENTRIES, FILE_VIEW_MAX_SCAN, type FileView, type FileViewKind, type FileViewHits, type FileViewEntry } from "./file-view-data"
export { highlight, isHighlighted, HIGHLIGHT_LANGUAGES, lexEntry, sanitizeState, isFreshState, type HighlightState } from "./syntax"
export { ideContext, ideSelectionKey, type IdePosition, type IdeEditorName, type IdeSelection, type IdeReport, type IdeOpenReport } from "./ide-data"
export { SLASH_LAYOUTS, SLASH_GROUPS, slashProfileProblems, type SlashLayout, type SlashGroupId, type SlashGroup, type SlashPreference } from "./slash-menu-data"
