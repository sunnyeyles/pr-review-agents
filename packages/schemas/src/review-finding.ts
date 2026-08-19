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
