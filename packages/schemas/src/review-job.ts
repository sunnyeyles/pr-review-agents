import { z } from "zod";

/**
 * A queued request to review one pull request at one commit.
 *
 * Produced by the webhook Lambda and consumed by the review worker;
 * this schema is the contract for messages on the review-jobs queue.
 */
export const reviewJobSchema = z.object({
  installationId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "expected a 40-character lowercase hex commit SHA"),
});

export type ReviewJob = z.infer<typeof reviewJobSchema>;
