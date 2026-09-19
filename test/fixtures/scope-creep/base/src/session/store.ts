// How long a session lasts before the user has to sign in again.
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

const sessions = new Map();

export function createSession(userId) {
  const session = { userId, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 };
  sessions.set(userId, session);
  return session;
}

export function sessionOf(userId) {
  const session = sessions.get(userId);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}
