// Token usage and list-price cost for the model runs (`hr classify`, `hr prelabel`).
import type Anthropic from "@anthropic-ai/sdk";

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
export const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

/** USD per million tokens: input, output, cache read, 5-minute cache write
 *  (claude-api skill: shared/models.md and shared/prompt-caching.md, 2026-10).
 *  Haiku 5.5's rate is for prompts of 100K tokens or fewer; every request here is far below that. */
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
} as const;
export type PricedModel = keyof typeof PRICES;

export function addUsage(u: Usage, r: Anthropic.Messages.Usage): Usage {
  return {
    input: u.input + r.input_tokens,
    output: u.output + r.output_tokens,
    cache_read: u.cache_read + (r.cache_read_input_tokens ?? 0),
    cache_write: u.cache_write + (r.cache_creation_input_tokens ?? 0),
  };
}

export function sumUsage(us: Usage[]): Usage {
  return us.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cache_read: a.cache_read + u.cache_read, cache_write: a.cache_write + u.cache_write }), NO_USAGE);
}

export function costUsd(u: Usage, model: PricedModel): number {
  const p = PRICES[model];
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / 1e6;
}

export function formatUsage(calls: number, u: Usage, model: PricedModel): string {
  return (
    `this run: ${calls} messages sent; tokens in ${u.input}, out ${u.output} (incl. thinking), cache read ${u.cache_read}, ` +
    `cache write ${u.cache_write}; $${costUsd(u, model).toFixed(2)} at ${model} list price`
  );
}
