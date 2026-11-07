// The spend guard (user 2026-11-07): every Anthropic client hr makes is wrapped in a CostGuard. Before each call it
// estimates that call from the request itself and, unless the command already printed the run's total, prints it;
// a run whose spend so far plus the next call's estimate passes COST_LIMIT_USD is refused unless the user passed
// --yes. Commands that know their calls up front (classify, prelabel, group, canon, the evals) also print and check
// the run's total before the first call, so a refusal comes before anything is spent.
import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, costUsd, NO_USAGE, PRICES, type PricedModel } from "./usage.ts";

export const COST_LIMIT_USD = 1;
/** Characters per input token for the estimate. Measured 2026-11-07 with the token-counting endpoint: 2.49 on the
 *  Cal Hacks Devpost canon request, 2.62 on 40 Slack posts. 2 makes the estimate err high. */
export const CHARS_PER_TOKEN = 2;

export interface PlannedCall {
  model: string;
  /** System prompt, messages and output schema, in characters. */
  input_chars: number;
  max_tokens: number;
}

export class CostRefused extends Error {}

/** One call at list price: every input character uncached, and the call's whole output budget, once (a retry after
 *  a failed output check costs another call). An unpriced model is never estimated low: it counts as Infinity. */
export function estimateUsd(calls: PlannedCall[]): number {
  return calls.reduce((n, c) => {
    const p = PRICES[c.model as PricedModel];
    return n + (p ? (Math.ceil(c.input_chars / CHARS_PER_TOKEN) * p.input + c.max_tokens * p.output) / 1e6 : Infinity);
  }, 0);
}

export function plannedCall(model: string, system: string, request: string, schema: object, max_tokens: number): PlannedCall {
  return { model, input_chars: system.length + request.length + JSON.stringify(schema).length, max_tokens };
}

const usd = (n: number) => (n === Infinity ? "an unpriced amount" : `$${n.toFixed(2)}`);

/** "3 model calls (claude-opus-5-5 ×3): estimated at most $1.42" */
export function describeCalls(calls: PlannedCall[]): string {
  if (!calls.length) return "no model calls";
  const by = new Map<string, number>();
  for (const c of calls) by.set(c.model, (by.get(c.model) ?? 0) + 1);
  return `${calls.length} model call${calls.length === 1 ? "" : "s"} (${[...by].map(([m, n]) => `${m} ×${n}`).join(", ")}): estimated at most ${usd(estimateUsd(calls))}`;
}

const text = (c: unknown): number =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text.length : JSON.stringify(b).length), 0) : 0;

/** The PlannedCall a request body describes: what the guard estimates before sending it. */
export function callOf(p: { model: string; max_tokens: number; system?: unknown; messages: { content: unknown }[]; output_config?: { format?: { schema?: unknown } | null } | null }): PlannedCall {
  const schema = p.output_config?.format?.schema;
  return { model: p.model, max_tokens: p.max_tokens, input_chars: text(p.system) + p.messages.reduce((n, m) => n + text(m.content), 0) + (schema ? JSON.stringify(schema).length : 0) };
}

export class CostGuard {
  private spent = 0;
  private planned = false;
  constructor(
    readonly label: string,
    readonly yes: boolean,
    private readonly log: (line: string) => void = console.log,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  /** The run's calls, before the first: prints the estimate; false (printed why) when it's over the limit without
   *  --yes. Per-call lines are not printed after this; the per-call check still runs. */
  preflight(calls: PlannedCall[]): boolean {
    this.planned = true;
    const est = estimateUsd(calls);
    this.log(`${this.label}: ${describeCalls(calls)}`);
    if (est > COST_LIMIT_USD && !this.yes) {
      this.log(`${this.label}: refused, over $${COST_LIMIT_USD.toFixed(2)}; rerun with --yes to spend it. Nothing was sent.`);
      return false;
    }
    return true;
  }

  /** Before each call: throws CostRefused when spend so far plus this call would pass the limit without --yes. */
  before(call: PlannedCall): void {
    const est = estimateUsd([call]);
    if (!this.planned) this.log(`${this.label}: ${describeCalls([call])}${this.spent ? ` (spent so far ${usd(this.spent)})` : ""}`);
    if (this.spent + est > COST_LIMIT_USD && !this.yes)
      throw new CostRefused(`${this.label}: refused, the next model call (estimated at most ${usd(est)}) would take this run past $${COST_LIMIT_USD.toFixed(2)} (spent ${usd(this.spent)}); rerun with --yes to spend it`);
  }

  after(model: string, usage: Anthropic.Messages.Usage): void {
    this.spent += PRICES[model as PricedModel] ? costUsd(addUsage(NO_USAGE, usage), model as PricedModel) : 0;
  }
}

/** The client every hr command uses: messages.create and messages.stream pass through the guard. */
export function guardClient(client: Anthropic, g: CostGuard): Anthropic {
  const messages = {
    create: (p: Anthropic.Messages.MessageCreateParamsNonStreaming, o?: Anthropic.RequestOptions) => {
      g.before(callOf(p));
      return client.messages.create(p, o).then((r) => (g.after(p.model, r.usage), r));
    },
    stream: (p: Anthropic.Messages.MessageStreamParams, o?: Anthropic.RequestOptions) => {
      g.before(callOf(p));
      const s = client.messages.stream(p, o);
      s.finalMessage().then((r) => g.after(p.model, r.usage), () => {});
      return s;
    },
  };
  return { messages } as unknown as Anthropic;
}
