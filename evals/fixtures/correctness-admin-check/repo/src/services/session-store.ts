/** Session token store, backed by Redis in production. */
import type { SessionUser } from "../auth/session.js";

export interface SessionStore {
  resolve(token: string): Promise<SessionUser | null>;
}

export const sessions: SessionStore = {
  async resolve(token) {
    void token;
    throw new Error("wired at startup by src/bootstrap.ts");
  },
};
