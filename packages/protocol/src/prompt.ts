import { z } from "zod"
import { PROMPT_FAMILIES, PROMPT_FOCUS_CHOICES, PROMPT_MODES } from "./prompt-data"
export const PromptMode = z.enum(PROMPT_MODES)
export const PromptFamily = z.enum(PROMPT_FAMILIES)
export const PromptFocusChoice = z.enum(PROMPT_FOCUS_CHOICES)
