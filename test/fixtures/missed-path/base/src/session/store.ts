import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map<string, Session>();

export function createSession(userId: string): Session {
  const session = { id: randomUUID(), userId, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(session.id, session);
  return session;
}

export function findSession(id: string): Session | undefined {
  const session = sessions.get(id);
  return session && session.expiresAt > Date.now() ? session : undefined;
}
