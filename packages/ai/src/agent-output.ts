/**
 * The Zod-validated contract for an agent's final message: a single
 * JSON object holding a findings array of the shared candidate
 * shape. Anything else is an agent failure — never a crash, and never
 * something that reaches the GitHub-writing pipeline.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { reviewFindingSchema, type ReviewFinding } from "@pr-review/schemas";
import { z } from "zod";

/**
 * The blocks of one `type`, matched structurally so a caller can pass
 * a response's `content` without narrowing it first.
 */
function blocksOfType<Block extends { type: string }>(
  content: readonly unknown[],
  type: Block["type"],
): Block[] {
  return content.filter(
    (block): block is Block =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === type,
  );
}

/**
 * The concatenated text of one message's content blocks — the bytes an
 * agent's or the Synthesiser's final answer actually arrives in.
 *
 * Shared because both callers of the Anthropic seam need it and must
 * read a message the same way: a response mixes text with tool_use
 * blocks, and a second implementation that joined them differently (or
 * forgot a block type) would change what {@link extractAgentOutput}
 * is handed without either caller looking wrong on its own.
 */
export function messageText(content: readonly unknown[]): string {
  return blocksOfType<Anthropic.Messages.TextBlock>(content, "text")
    .map((block) => block.text)
    .join("\n");
}

/** The tool_use blocks of one message's content, in order. */
export function toolUseBlocks(
  content: readonly unknown[],
): Anthropic.Messages.ToolUseBlock[] {
  return blocksOfType<Anthropic.Messages.ToolUseBlock>(content, "tool_use");
}

/** The only output an agent can produce: candidate findings. */
export const agentOutputSchema = z.object({
  findings: z.array(reviewFindingSchema),
});

export type AgentOutputResult =
  | { ok: true; findings: ReviewFinding[] }
  | { ok: false; error: string };

/**
 * Extracts and validates the findings JSON from an agent's final
 * message text. Tolerates prose and markdown fences around the object
 * (everything outside the outermost braces is ignored) but the JSON
 * itself must parse and match agentOutputSchema exactly.
 */
export function extractAgentOutput(text: string): AgentOutputResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, error: "final message contains no JSON object" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return {
      ok: false,
      error: `final message JSON does not parse: ${String(error)}`,
    };
  }

  const parsed = agentOutputSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: `final message JSON failed schema validation: ${parsed.error.message}`,
    };
  }

  return { ok: true, findings: parsed.data.findings };
}
