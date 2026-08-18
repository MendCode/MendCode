import z from "zod"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigKeybinds } from "@/config/keybinds"

const KeybindOverride = z
  .object(
    Object.fromEntries(Object.keys(ConfigKeybinds.Keybinds.shape).map((key) => [key, z.string().optional()])) as Record<
      string,
      z.ZodOptional<z.ZodString>
    >,
  )
  .strict()

const PromptStatusConfigOverride = z
  .object({
    commandsHint: z
      .object({
        visible: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough()

const HomeConfigOverride = z
  .object({
    logo: z
      .object({
        mode: z.enum(["title", "mascot"]).optional(),
        size: z.enum(["compact", "default", "large"]).optional(),
        path: z.string().optional(),
        text: z.string().optional(),
      })
      .strict()
      .optional(),
    welcome: z
      .object({
        mode: z.enum(["centered", "split"]).optional(),
        rightPanel: z.enum(["actions", "agentManager"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const IdentityConfigOverride = z
  .object({
    productName: z.string().min(1).optional(),
    tagline: z.string().optional(),
    logoMode: z.enum(["title", "mascot"]).optional(),
    logoFont: z.enum(["classic", "mendcode", "opencode", "small", "standard", "shadow"]).optional(),
  })
  .strict()

const SessionHistoryConfigOverride = z
  .object({
    enabled: z.boolean().optional(),
    view: z.enum(["auto", "timeline", "tree", "split", "chapters", "pages"]).optional(),
    split: z.union([z.boolean(), z.literal("auto")]).optional(),
    page_size: z.number().int().min(10).max(200).optional(),
    group_by: z.enum(["day", "none"]).optional(),
    show_tools: z.enum(["hidden", "count", "tree"]).optional(),
    show_subagents: z.boolean().optional(),
    search: z.boolean().optional(),
    remember_position: z.boolean().optional(),
    open_at: z.enum(["latest", "oldest"]).optional(),
    preview_width: z.number().int().min(40).max(75).optional(),
    // Kept so older configs continue to parse; chapters now map to timeline.
    chapter_gap_minutes: z.number().int().min(5).max(180).optional(),
    search_page_limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict()

export const TuiOptions = z.object({
  scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
  scroll_acceleration: z
    .object({
      enabled: z.boolean().describe("Enable scroll acceleration"),
    })
    .optional()
    .describe("Scroll acceleration settings"),
  diff_style: z
    .enum(["auto", "stacked"])
    .optional()
    .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
  mouse: z.boolean().optional().describe("Enable or disable mouse capture (default: true)"),
})

export const TuiInfo = z
  .object({
    $schema: z.string().optional(),
    theme: z.string().optional(),
    keybinds: KeybindOverride.optional(),
    promptStatus: PromptStatusConfigOverride.optional(),
    presentation: z.any().optional(),
    home: HomeConfigOverride.optional(),
    identity: IdentityConfigOverride.optional(),
    session_history: SessionHistoryConfigOverride.optional(),
    plugin: ConfigPlugin.Spec.zod.array().optional(),
    plugin_enabled: z.record(z.string(), z.boolean()).optional(),
  })
  .extend(TuiOptions.shape)
  .strict()
