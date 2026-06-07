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
    plugin: ConfigPlugin.Spec.zod.array().optional(),
    plugin_enabled: z.record(z.string(), z.boolean()).optional(),
  })
  .extend(TuiOptions.shape)
  .strict()
