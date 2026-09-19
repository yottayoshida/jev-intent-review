export async function exchangeCode(code) {
  const response = await fetch("https://provider.example.com/token", { method: "POST", body: code });
  if (!response.ok) {
    const again = await fetch("https://provider.example.com/token", { method: "POST", body: code });
    if (!again.ok) throw new Error(`token exchange failed: ${again.status}`);
    return again.json();
  }
  return response.json();
}
