import { exchangeCode } from "./exchange.ts";
import { createSession } from "../session/store.ts";

// The provider's token endpoint drops a request now and then; exchangeCode retries once.
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
