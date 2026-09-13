import { z } from "zod";

import { findingCategorySchema } from "./review-finding.js";

const count = z.number().int().nonnegative();

/** One (category, title shape) pair and how the repository has treated it. */
export const memoryShapeSchema = z
  .object({
    category: findingCategorySchema,
    shape: z.string().min(1).max(200),
    resolved: count,
    ignored: count,
    outdated: count,
    lastSignalAt: z.iso.datetime(),
  })
  .strict();

export type MemoryShape = z.infer<typeof memoryShapeSchema>;

/** The whole memory file. Untrusted input: strict, so junk is rejected. */
export const reviewMemorySchema = z
  .object({
    version: z.literal(1),
    shapes: z.array(memoryShapeSchema),
  })
  .strict();

export type ReviewMemory = z.infer<typeof reviewMemorySchema>;
