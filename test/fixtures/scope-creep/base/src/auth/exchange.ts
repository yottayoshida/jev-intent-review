export async function exchangeCode(code) {
  const response = await fetch("https://provider.example.com/token", { method: "POST", body: code });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  return response.json();
}
