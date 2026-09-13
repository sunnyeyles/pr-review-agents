/** Session loading for the API surface. */
import type { Request } from "express";

import { sessions } from "../services/session-store.js";

export type Role = "admin" | "member" | "billing";

export interface SessionUser {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
}

/**
 * Resolves the signed session cookie into the user it belongs to, or
 * null when the request carries no valid session.
 */
export async function loadSessionUser(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.["session"];
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return sessions.resolve(token);
}
