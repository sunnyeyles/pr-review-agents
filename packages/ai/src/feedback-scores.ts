/**
 * Human feedback as Langfuse scores. Kept separate from prompts.ts and
 * model-tracing.ts so nothing on the review path can reach a writer.
 */
import { createLangfuseClient, type LangfusePromptClientConfig } from "./prompts.js";

/** The score every thumbs reaction lands under; averaging it gives the helpful rate. */
export const FEEDBACK_SCORE_NAME = "finding-helpful";

/** One reaction, as a score on the trace of the review that produced the finding. */
export interface FeedbackScore {
  /** Deterministic per reaction, so a re-run upserts rather than duplicates. */
  id: string;
  traceId: string;
  /** 1 for a thumbs up, 0 for a thumbs down. */
  value: 0 | 1;
  comment: string;
  metadata: Record<string, string | number>;
}

/** Injectable seam over score writing; tests capture, the SDK batches. */
export interface FeedbackScoreSink {
  record(score: FeedbackScore): void;
  /** Sends everything recorded so far; the process must not exit before it resolves. */
  flush(): Promise<void>;
}

export function createLangfuseScoreSink(
  config: LangfusePromptClientConfig,
): FeedbackScoreSink {
  const client = createLangfuseClient(config);
  return {
    record(score) {
      client.score.create({
        id: score.id,
        traceId: score.traceId,
        name: FEEDBACK_SCORE_NAME,
        value: score.value,
        dataType: "BOOLEAN",
        comment: score.comment,
        metadata: score.metadata,
      });
    },
    async flush() {
      await client.score.flush();
    },
  };
}
