import { createSession, type Session } from "../session/store.ts";
import { findUserByEmail } from "../users/repo.ts";
import { AuthError } from "./errors.ts";
import { verifyPassword } from "./hash.ts";

export async function loginWithPassword(email: string, password: string): Promise<Session> {
  const user = findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new AuthError("invalid email or password");
  }
  return createSession(user.id);
}
