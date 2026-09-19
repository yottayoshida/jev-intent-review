import { createHmac, timingSafeEqual } from "node:crypto";
import { createSession, type Session } from "../session/store.ts";
import { findUserById } from "../users/repo.ts";
import { AuthError } from "./errors.ts";

const HANDSHAKE_SECRET = process.env.HANDSHAKE_SECRET ?? "";

function verifyHandshakeToken(token: string): { userId: string } | null {
  const [userId, signature] = token.split(".");
  if (!userId || !signature) return null;
  const expected = createHmac("sha256", HANDSHAKE_SECRET).update(userId).digest();
  const given = Buffer.from(signature, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { userId } : null;
}

export function authenticateHandshake(token: string): Session {
  const claims = verifyHandshakeToken(token);
  if (!claims) throw new AuthError("invalid handshake token");
  const user = findUserById(claims.userId);
  if (!user) throw new AuthError("unknown user");
  if (user.disabledAt) throw new AuthError("account disabled");
  return createSession(user.id);
}
