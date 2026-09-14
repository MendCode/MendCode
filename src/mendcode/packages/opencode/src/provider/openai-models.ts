import type * as ModelsDev from "./models"

const GPT_56_REASONING = ["none", "low", "medium", "high", "xhigh", "max"]
const GPT_6_ASTRA_REASONING = ["low", "medium", "high", "xhigh", "max"]

const GPT_56_LIMIT = {
  context: 1_050_000,
  input: 922_000,
  output: 128_000,
}

const GPT_56_MODALITIES = {
  input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
  output: ["text"] as Array<"text">,
}

const GPT_56_BASE = {
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: GPT_56_REASONING }],
  temperature: false,
  tool_call: true,
  limit: GPT_56_LIMIT,
  modalities: GPT_56_MODALITIES,
  release_date: "2026-07-09",
}

const GPT_56_PRO_MODE = {
  provider: { body: { reasoning: { mode: "pro" } } },
}

function gpt56Modes(fastCost: ModelsDev.Model["cost"]) {
  return {
    fast: {
      cost: fastCost,
      provider: { body: { service_tier: "priority" } },
    },
    pro: GPT_56_PRO_MODE,
  }
}

const GPT_56_COSTS = {
  sol: {
    input: 4,
    output: 20,
    cache_read: 0.4,
    cache_write: 5,
    context_over_200k: {
      input: 8,
      output: 30,
      cache_read: 0.8,
      cache_write: 10,
    },
  },
  terra: {
    input: 2,
    output: 12,
    cache_read: 0.2,
    cache_write: 2.5,
    context_over_200k: {
      input: 4,
      output: 18,
      cache_read: 0.4,
      cache_write: 5,
    },
  },
  luna: {
    input: 0.2,
    output: 1.2,
    cache_read: 0.02,
    cache_write: 0.25,
    context_over_200k: {
      input: 0.4,
      output: 1.8,
      cache_read: 0.04,
      cache_write: 0.5,
    },
  },
}

const GPT_56_FAST_COSTS = {
  sol: { input: 8, output: 40, cache_read: 0.8, cache_write: 10 },
  terra: { input: 4, output: 24, cache_read: 0.4, cache_write: 5 },
  luna: { input: 0.4, output: 2.4, cache_read: 0.04, cache_write: 0.5 },
}

const GPT_6_ASTRA_COST = {
  input: 10,
  output: 50,
  cache_read: 1,
  cache_write: 12.5,
  context_over_200k: {
    input: 20,
    output: 75,
    cache_read: 2,
    cache_write: 25,
  },
}

const GPT_6_ASTRA_FAST_COST = {
  input: 20,
  output: 100,
  cache_read: 2,
  cache_write: 25,
  context_over_200k: {
    input: 40,
    output: 150,
    cache_read: 4,
    cache_write: 50,
  },
}

const GPT_6_ASTRA_MODES = {
  fast: {
    cost: GPT_6_ASTRA_FAST_COST,
    provider: { body: { service_tier: "priority" } },
  },
}

function gpt56Model(
  id: string,
  name: string,
  family: string,
  cost: ModelsDev.Model["cost"],
  fastCost: ModelsDev.Model["cost"],
): ModelsDev.Model {
  return {
    id,
    name,
    family,
    ...GPT_56_BASE,
    cost,
    experimental: { modes: gpt56Modes(fastCost) },
  }
}

/**
 * Keep the picker usable when a cached or bundled models.dev catalog predates
 * the current OpenAI model family. Live catalog entries always win.
 */
export const OPENAI_MODEL_FALLBACKS: Record<string, ModelsDev.Model> = {
  "gpt-5.6": gpt56Model("gpt-5.6", "GPT-5.6", "gpt-sol", GPT_56_COSTS.sol, GPT_56_FAST_COSTS.sol),
  "gpt-5.6-sol": gpt56Model(
    "gpt-5.6-sol",
    "GPT-5.6 Sol",
    "gpt-sol",
    GPT_56_COSTS.sol,
    GPT_56_FAST_COSTS.sol,
  ),
  "gpt-5.6-terra": gpt56Model(
    "gpt-5.6-terra",
    "GPT-5.6 Terra",
    "gpt-terra",
    GPT_56_COSTS.terra,
    GPT_56_FAST_COSTS.terra,
  ),
  "gpt-5.6-luna": gpt56Model(
    "gpt-5.6-luna",
    "GPT-5.6 Luna",
    "gpt-luna",
    GPT_56_COSTS.luna,
    GPT_56_FAST_COSTS.luna,
  ),
  "gpt-6-astra": {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    family: "gpt-astra",
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: GPT_6_ASTRA_REASONING }],
    temperature: false,
    tool_call: true,
    limit: {
      context: 1_050_000,
      input: 922_000,
      output: 128_000,
    },
    modalities: GPT_56_MODALITIES,
    // OpenAI publishes a knowledge cutoff for Astra, but not a model release
    // date on the model page. Keep this field empty until the catalog provides
    // an authoritative value.
    release_date: "",
    cost: GPT_6_ASTRA_COST,
    experimental: { modes: GPT_6_ASTRA_MODES },
  },
}

export function withOpenAIModelFallbacks(catalog: Record<string, ModelsDev.Provider>) {
  const provider = catalog.openai
  if (!provider) return catalog
  return {
    ...catalog,
    openai: {
      ...provider,
      models: {
        ...OPENAI_MODEL_FALLBACKS,
        ...provider.models,
      },
    },
  }
}
