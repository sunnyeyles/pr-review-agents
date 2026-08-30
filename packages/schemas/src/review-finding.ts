import { z } from "zod";

/**
 * One structured review finding. `line` is a new-side line number and is
 * optional; `confidence` is the agent's self-assessed certainty in [0, 1].
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
 * Keeps only candidates matching the finding contract. Shared by the
 * Synthesiser and the validation chain, which must agree. Dropping
 * silently is deliberate: malformed model output is an ordinary outcome.
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
