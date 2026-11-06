// The shared model call (v2 D2): one streamed structured-output request, then parse → check → retry with
// the error, up to OUTPUT_RETRIES. Used by `hr group` (v1 grouping), `hr canon` (page extraction) and the
// canon judge. The check decides what "valid" means; this only moves the error back to the model.
import Anthropic from "@anthropic-ai/sdk";
import { OUTPUT_RETRIES } from "./classify.ts";
import { addUsage, NO_USAGE, type Usage } from "./usage.ts";

export interface CheckedCall<T> {
  model: string;
  effort: "low" | "medium" | "high" | "max";
  max_tokens: number;
  system: string;
  schema: object;
  request: string;
  /** Returns the accepted value, or an error the model is told about on the next attempt. */
  check: (parsed: unknown) => T | { error: string };
  /** What to ask for after a failed check. */
  retry?: (error: string) => string;
}

export type CheckedResult<T> = ({ value: T } | { error: string }) & { usage: Usage; calls: number };

export async function callChecked<T>(client: Anthropic, c: CheckedCall<T>): Promise<CheckedResult<T>> {
  let usage = NO_USAGE;
  let reason = "";
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: c.request }];
  for (let attempt = 1; attempt <= 1 + OUTPUT_RETRIES; attempt++) {
    let res: Anthropic.Messages.Message;
    try {
      res = await client.messages
        .stream({
          model: c.model,
          max_tokens: c.max_tokens,
          system: [{ type: "text", text: c.system, cache_control: { type: "ephemeral" } }],
          output_config: { effort: c.effort, format: { type: "json_schema", schema: c.schema as Record<string, unknown> } },
          messages,
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) return { error: `API ${e.status ?? "connection"}: ${e.message}`, usage, calls: attempt };
      throw e;
    }
    usage = addUsage(usage, res.usage);
    if (res.stop_reason === "refusal") return { error: "refusal", usage, calls: attempt };
    if (res.stop_reason === "max_tokens") {
      reason = "hit max_tokens";
      continue;
    }
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      reason = "no text block";
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      reason = "output is not JSON";
      continue;
    }
    const checked = c.check(parsed);
    if (typeof checked === "object" && checked !== null && "error" in checked) {
      reason = checked.error;
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: (c.retry ?? defaultRetry)(reason) });
      continue;
    }
    return { value: checked as T, usage, calls: attempt };
  }
  return { error: reason, usage, calls: 1 + OUTPUT_RETRIES };
}

const defaultRetry = (reason: string) => `That output failed validation: ${reason}. Return the corrected JSON for the same input.`;
