import { z } from "zod";

/**
 * One structured review finding, as produced by the review agents and
 * consumed by the deterministic findings pipeline.
 *
 * - `line` is a new-side (post-change) line number and is optional:
 *   findings without one apply to the file as a whole.
 * - `confidence` is the agent's self-assessed certainty in [0, 1]; the
 *   pipeline drops findings below its confidence threshold.
 */
export const reviewFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  category: z.enum(["correctness", "security", "architecture"]),
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  explanation: z.string().min(1),
  suggestedFix: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export type FindingCategory = ReviewFinding["category"];

/**
 * Keeps only the candidates that match the finding contract, dropping
 * the rest silently.
 *
 * Both places that read raw model output need exactly this and must
 * agree: the Synthesiser filters before spending tokens refining
 * candidates, and the deterministic validation chain filters as its
 * first step. A candidate the Synthesiser considered well-formed but
 * validation did not would be refined and then dropped — tokens spent
 * on a finding that could never publish — so the definition lives
 * here, beside the schema it applies.
 *
 * Dropping silently is the point: malformed output is an ordinary
 * outcome for a model, not an error worth failing a review over.
 */
export function wellFormedFindings(
  candidates: readonly unknown[],
): ReviewFinding[] {
  const wellFormed: ReviewFinding[] = [];
  for (const candidate of candidates) {
    const parsed = reviewFindingSchema.safeParse(candidate);
    if (parsed.success) {
      wellFormed.push(parsed.data);
    }
  }
  return wellFormed;
}
