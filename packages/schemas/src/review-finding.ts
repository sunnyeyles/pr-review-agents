import { z } from "zod";

/**
 * A category names one review lens, and the set of lenses is
 * configurable — so the shape is constrained here and membership is
 * checked against the lenses a given run was configured with.
 */
export const findingCategorySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase kebab-case slug")
  .max(40);

export type FindingCategory = z.infer<typeof findingCategorySchema>;

/**
 * One structured review finding. `line` is a new-side line number and is
 * optional; `confidence` is the agent's self-assessed certainty in [0, 1].
 */
export const reviewFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  category: findingCategorySchema,
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  explanation: z.string().min(1),
  suggestedFix: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** "performance" -> "Performance", "data-access" -> "Data access". */
export function categoryLabel(category: string): string {
  const words = category.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
