import { createSession, type Session } from "../session/store.ts";
import { findUserByOAuthSubject } from "../users/repo.ts";
import { AuthError } from "./errors.ts";

interface Profile {
  subject: string;
  email: string;
}

async function exchangeCode(code: string): Promise<Profile> {
  const response = await fetch("https://id.example.com/token", { method: "POST", body: new URLSearchParams({ code }) });
  if (!response.ok) throw new AuthError("the identity provider refused the code");
  return (await response.json()) as Profile;
}

export async function completeOAuthLogin(code: string): Promise<Session> {
  const profile = await exchangeCode(code);
  const user = findUserByOAuthSubject(profile.subject);
  if (!user) {
    throw new AuthError("no account is linked to this identity");
  }
  if (user.disabledAt) throw new AuthError("account disabled");
  return createSession(user.id);
}
