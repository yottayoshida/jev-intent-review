// Calls to Cloudflare Workers AI over REST. The API token is held here and nowhere else: it is not
// part of any object that gets printed, serialised or traced.

export type ProviderErrorKind =
  | "auth" // 401 / 403: the token is wrong or lacks Workers AI permission
  | "payment" // 402: the account's balance is empty
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "bad_request"
  | "bad_response"
  | "budget"; // this run's own request / byte / time limit

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

export interface Credentials {
  accountId: string;
  apiToken: string;
}

/** Credentials from CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN, or null when either is unset. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (accountId === "" || apiToken === "") return null;
  // The account id goes into the URL path; anything but the documented 32 hex digits is refused.
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new ProviderError("auth", "CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters");
  if (/\s/.test(apiToken)) throw new ProviderError("auth", "CLOUDFLARE_API_TOKEN must not contain whitespace");
  return { accountId, apiToken };
}

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms after which no request starts and no retry waits; the run's time budget. */
  deadline?: number;
  /** The run's request and byte budget, counted on what is actually sent (retries included). */
  maxRequests?: number;
  maxBytes?: number;
  now?: () => number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class CloudflareClient {
  /** What actually went over the wire, retries included. */
  readonly sent = { requests: 0, bytes: 0 };
  readonly #credentials: Credentials;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #deadline: number;
  readonly #maxRequests: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(credentials: Credentials, options: ClientOptions = {}) {
    this.#credentials = credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    this.#maxRequests = options.maxRequests ?? Number.POSITIVE_INFINITY;
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#now = options.now ?? Date.now;
  }

  /** Waits before a retry, unless the wait would run past the deadline. */
  async #wait(ms: number): Promise<void> {
    if (ms >= this.#deadline - this.#now()) throw new ProviderError("budget", "time limit reached before the next retry");
    await this.#sleep(ms);
  }

  /** POSTs `body` to `/accounts/{id}/{path}` and returns the parsed JSON. Retries 429 and 5xx. */
  async post(path: string, body: unknown): Promise<unknown> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.#credentials.accountId}/${path}`;
    const payload = JSON.stringify(body);
    const size = Buffer.byteLength(payload, "utf8");
    for (let attempt = 0; ; attempt++) {
      const remaining = this.#deadline - this.#now();
      if (remaining <= 0) throw new ProviderError("budget", "time limit reached");
      if (this.sent.requests + 1 > this.#maxRequests) throw new ProviderError("budget", `request limit reached (${this.#maxRequests})`);
      if (this.sent.bytes + size > this.#maxBytes) throw new ProviderError("budget", `byte limit reached (${this.#maxBytes})`);
      const timeout = Math.min(this.#timeoutMs, remaining);
      let response: Response;
      let text: string;
      try {
        this.sent.requests += 1;
        this.sent.bytes += size;
        response = await this.#fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#credentials.apiToken}`, "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(timeout),
        });
        if (RETRYABLE.has(response.status) && attempt < this.#maxRetries) {
          await response.body?.cancel();
          await this.#wait(retryAfter(response) ?? backoff(attempt));
          continue;
        }
        text = await response.text(); // reading the body can time out as well
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (attempt < this.#maxRetries) {
          await this.#wait(backoff(attempt));
          continue;
        }
        throw new ProviderError(timedOut ? "timeout" : "network", timedOut ? `no answer within ${timeout} ms` : `request failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) throw new ProviderError(kindOf(response.status), `Workers AI ${response.status}: ${text.slice(0, 200)}`, response.status);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError("bad_response", `Workers AI returned something other than JSON: ${text.slice(0, 120)}`, response.status);
      }
      if (json && typeof json === "object" && (json as { success?: unknown }).success === false) {
        const errors = (json as { errors?: { message?: string }[] }).errors;
        throw new ProviderError("bad_response", `Workers AI reported failure: ${errors?.[0]?.message ?? "no message"}`, response.status);
      }
      return json;
    }
  }
}

function kindOf(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

function backoff(attempt: number): number {
  return 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : null;
}
