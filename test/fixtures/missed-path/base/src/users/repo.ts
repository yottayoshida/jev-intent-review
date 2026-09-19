export interface User {
  id: string;
  email: string;
  passwordHash: string;
  oauthSubject?: string;
  disabledAt?: Date;
}

export interface ApiKey {
  key: string;
  userId: string;
}

const users = new Map<string, User>();
const apiKeys = new Map<string, ApiKey>();

export function findUserById(id: string): User | undefined {
  return users.get(id);
}

export function findUserByEmail(email: string): User | undefined {
  for (const user of users.values()) if (user.email === email) return user;
  return undefined;
}

export function findUserByOAuthSubject(subject: string): User | undefined {
  for (const user of users.values()) if (user.oauthSubject === subject) return user;
  return undefined;
}

export function findApiKey(key: string): ApiKey | undefined {
  return apiKeys.get(key);
}
