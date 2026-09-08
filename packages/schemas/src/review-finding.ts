import { z } from "zod";

/**
 * A category names one review agent, and the agent set is configurable — the
 * shape is constrained here, membership against the run's agents.
 */
export const findingCategorySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase kebab-case slug")
  .max(40);

export type FindingCategory = z.infer<typeof findingCategorySchema>;

/**
 * A mechanical replacement of new-side lines `startLine`..`endLine`.
 * `expected` is that range's exact current text; a mismatch discards the patch.
 */
export const findingPatchSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    expected: z.string().min(1),
    // Empty deletes the range.
    replacement: z.string(),
  })
  .refine((patch) => patch.endLine >= patch.startLine, {
    message: "endLine must not precede startLine",
  });

export type FindingPatch = z.infer<typeof findingPatchSchema>;

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
  patch: findingPatchSchema.optional(),
  confidence: z.number().min(0).max(1),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** "performance" -> "Performance", "data-access" -> "Data access". */
export function categoryLabel(category: string): string {
  const words = category.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Keeps only candidates matching the finding contract. Dropping silently is
 * deliberate: malformed model output is an ordinary outcome.
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
