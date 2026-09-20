import { createSession, type Session } from "../session/store.ts";
import { findApiKey } from "../users/repo.ts";
import { AuthError } from "./errors.ts";

export function loginWithApiKey(key: string): Session {
  const record = findApiKey(key);
  if (!record) throw new AuthError("unknown API key");
  return createSession(record.userId);
}
