import { exchangeCode } from "./exchange.ts";
import { createSession } from "../session/store.ts";

export async function completeOAuthLogin(code) {
  const tokens = await exchangeCode(code);
  const user = await profileOf(tokens);
  return createSession(user.id);
}

async function profileOf(tokens) {
  const response = await fetch("https://provider.example.com/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access}` },
  });
  return response.json();
}
