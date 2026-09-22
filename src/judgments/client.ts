// Jev over REST, on whichever host the user named: Cloudflare Workers AI, TypeSafe or Vercel AI
// Gateway, or an endpoint set by `JEV_API_URL`. Each host has its own fixed URL, its own name for
// Jev and its own request shape, kept in one closed table here. The API token is held here and
// nowhere else: it is not part of any object that gets printed, serialised or traced, and nothing
// the endpoint returns reaches a log without being flattened.

export type ProviderErrorKind =
  | "auth" // 401 / 403: the token was refused
  | "endpoint" // this URL does not run models: nothing is sent after it, bar what is already in flight
  | "payment" // 402: the account's balance is empty
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "bad_request"
  | "bad_response"
  | "refused" // a model this tool does not send to: nothing leaves the process
  | "budget"; // this run's own request / byte / time limit

/** The hosts a user can name with `JEV_PROVIDER`. */
export const PROVIDERS = ["cloudflare", "typesafe", "vercel"] as const;
export type Provider = (typeof PROVIDERS)[number];
/** `custom` is an endpoint set by `JEV_API_URL`, which speaks the Workers AI run request. */
export type Host = Provider | "custom";

interface HostSpec {
  name: string; // how a message or a report names it
  model: string; // Jev's name on this host, and the only model this tool sends it
  shape: "workers-ai" | "systemone";
}

/**
 * The only model this tool sends anything to, per host: Jev, under the name each host gives it.
 *
 * It lives at the transport rather than beside the callers, because a caller that wants a second
 * model is exactly the thing being prevented. Every request — the CLI's, a bench script's, a
 * retry — goes through `post`, so this is the one place that sees all of them. An `Endpoint` says
 * which host it is and nothing more, so no caller can put another model's name into it.
 *
 * The tool exists to ask Jev small typed questions. Reaching for a general instruct model to write
 * a plan, or a mapping, or a sentence of prose, quietly makes it a different tool, and each of
 * those reaches looked locally reasonable at the time.
 */
const HOSTS: Readonly<Record<Host, HostSpec>> = {
  cloudflare: { name: "Cloudflare Workers AI", model: "typesafe/jev", shape: "workers-ai" },
  typesafe: { name: "TypeSafe", model: "jev-latest", shape: "systemone" },
  vercel: { name: "Vercel AI Gateway", model: "typesafe-ai/jev", shape: "systemone" },
  custom: { name: "the endpoint set by JEV_API_URL", model: "typesafe/jev", shape: "workers-ai" },
};

// Documented at https://docs.typesafe.ai/api and
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe. Vercel routes each request to a
// provider of Jev: TypeSafe only, as of September 2026.
const FIXED_URL: Readonly<Record<"typesafe" | "vercel", string>> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  vercel: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
};

const CLOUDFLARE_URL = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/run$/i;

/** Jev's name on `host`: the one model a request to it may ask for. */
export function jevModel(host: Host): string {
  return HOSTS[host].model;
}

/** How a message or a report names `host`. */
export function hostName(host: Host): string {
  return HOSTS[host].name;
}

/**
 * Every environment variable that decides where judgments go, or carries the key for it. One list,
 * so that selecting a host, keeping these out of git's environment, and (later) a GitHub Action
 * discarding what it inherited all agree on what they are.
 */
export const JUDGMENT_SECRET_ENV = ["JEV_API_TOKEN", "CLOUDFLARE_API_TOKEN", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"] as const;
export const JUDGMENT_ENV = ["JEV_PROVIDER", "JEV_API_URL", "CLOUDFLARE_ACCOUNT_ID", ...JUDGMENT_SECRET_ENV] as const;

/** The kinds that make every later request pointless: the run ends rather than asking again. */
export const FATAL_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(["auth", "payment", "endpoint"]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  /** The host and its origin, when the failure came from one: never text the host chose. */
  readonly where: string | undefined;
  constructor(kind: ProviderErrorKind, message: string, status?: number, where?: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.where = where;
  }
}

export interface Endpoint {
  host: Host;
  url: string; // the exact address every request is POSTed to
  token: string;
}

/** A misconfigured environment: the caller turns this into exit 10, as for any bad setting. */
export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

// A host that is this machine. Compared against the parsed hostname, whole: `localhost.example.com`
// is someone else's name, and `127.0.0.1.nip.io` resolves wherever its owner points it.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Empty and blank count as unset: an input a workflow did not fill arrives as "". */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function checkedToken(token: string, name: string): string {
  if (/\s/.test(token)) throw new EndpointError(`${name} must not contain whitespace`);
  return token;
}

/**
 * The address to POST to, checked. Only the origin ever appears in an error: a path or a query can
 * carry the very thing this refuses to hand out.
 */
function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointError("JEV_API_URL is not a URL");
  }
  if (url.username !== "" || url.password !== "") throw new EndpointError("JEV_API_URL must not carry a user name or password");
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.href;
  throw new EndpointError(`JEV_API_URL must be https (http only for localhost): ${url.protocol}//${url.host}`);
}

function isProvider(name: string): name is Provider {
  return (PROVIDERS as readonly string[]).includes(name);
}

/** The host `JEV_PROVIDER` names, when it names one; `endpointFromEnv` refuses any other value. */
export function namedProvider(env: NodeJS.ProcessEnv = process.env): Provider | undefined {
  const named = value(env.JEV_PROVIDER);
  return named !== undefined && isProvider(named) ? named : undefined;
}

/** What `provider` needs set before it can be asked, for a message that says what is missing. */
export const PROVIDER_KEYS: Readonly<Record<Provider, readonly string[]>> = {
  cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  typesafe: ["TYPESAFE_API_KEY"],
  vercel: ["AI_GATEWAY_API_KEY"],
};

function cloudflareEndpoint(accountId: string | undefined, token: string | undefined): Endpoint | null {
  if (accountId === undefined || token === undefined) return null;
  // The account id goes into the URL path; anything but the documented 32 hex digits is refused.
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new EndpointError("CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters");
  return { host: "cloudflare", url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`, token: checkedToken(token, "CLOUDFLARE_API_TOKEN") };
}

/**
 * Where judgments go, or null when no credentials were given (the caller's policy decides what
 * that means). Each key goes only to its own host's fixed URL, and `JEV_API_TOKEN` only to
 * `JEV_API_URL`.
 *
 * `JEV_PROVIDER` names the host, and then no other host's key changes the outcome. Without it,
 * selection is what it was before TypeSafe and Vercel were added: `JEV_API_URL`, else the
 * Cloudflare pair. `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` never select a host on their own:
 * Vercel's key serves every model it routes, and a key kept for something else must not start
 * sending this repository's code anywhere.
 */
export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): Endpoint | null {
  const provider = value(env.JEV_PROVIDER);
  const url = value(env.JEV_API_URL);
  const token = value(env.JEV_API_TOKEN);
  const accountId = value(env.CLOUDFLARE_ACCOUNT_ID);
  const cloudflareToken = value(env.CLOUDFLARE_API_TOKEN);

  if (url === undefined && token !== undefined) throw new EndpointError("JEV_API_TOKEN needs JEV_API_URL: it is sent nowhere else, and a host named by JEV_PROVIDER takes its own key (CLOUDFLARE_API_TOKEN, TYPESAFE_API_KEY or AI_GATEWAY_API_KEY)");
  if (provider !== undefined) {
    // The value is not repeated: whatever was put there by mistake stays out of the log.
    if (!isProvider(provider)) throw new EndpointError(`JEV_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
    if (url !== undefined) throw new EndpointError("JEV_PROVIDER and JEV_API_URL both name where judgments go: set one of them");
    // A missing key is no credentials, as for a fork's pull request, whatever other hosts' keys are set.
    switch (provider) {
      case "cloudflare":
        return cloudflareEndpoint(accountId, cloudflareToken);
      case "typesafe": {
        const key = value(env.TYPESAFE_API_KEY);
        return key === undefined ? null : { host: "typesafe", url: FIXED_URL.typesafe, token: checkedToken(key, "TYPESAFE_API_KEY") };
      }
      case "vercel": {
        const key = value(env.AI_GATEWAY_API_KEY);
        return key === undefined ? null : { host: "vercel", url: FIXED_URL.vercel, token: checkedToken(key, "AI_GATEWAY_API_KEY") };
      }
    }
  }
  if (url !== undefined) {
    const checked = checkedUrl(url); // checked even without a token, so a bad URL is said now, not later
    if (token === undefined) {
      if (cloudflareToken !== undefined) throw new EndpointError("JEV_API_URL needs JEV_API_TOKEN: CLOUDFLARE_API_TOKEN is only ever sent to Cloudflare");
      return null; // a fork's pull request sees the URL but not the secret
    }
    return { host: "custom", url: checked, token: checkedToken(token, "JEV_API_TOKEN") };
  }
  return cloudflareEndpoint(accountId, cloudflareToken);
}

/**
 * Text from the endpoint, fit to print: no control characters to forge a line with (a workflow
 * command, a terminal escape), and never the token itself, which a mirror of the request hands
 * straight back.
 */
export function fromEndpoint(text: string, token: string, limit = 200): string {
  // Also the characters that reorder what is shown (U+202A-E, U+2066-9): the text is quoted in a
  // report a person reads.
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim();
  return (token === "" ? flat : flat.split(token).join("[REDACTED TOKEN]")).slice(0, limit);
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

// 529 is TypeSafe's "overloaded", which its documentation says to retry with backoff.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export class JevClient {
  /** What actually went over the wire, retries included. */
  readonly sent = { requests: 0, bytes: 0 };
  /** Where it went: scheme, host and port, for the report and the trace. No path, no query. */
  readonly origin: string;
  readonly host: Host;
  /** The host's name and origin, as every failure names it. Nothing in it comes from the host. */
  readonly where: string;
  /** Jev's name on this host: the only model `post` lets through. */
  readonly model: string;
  readonly #endpoint: Endpoint;
  // Once the endpoint has refused everything of its kind (a wrong URL, a refused token, an empty
  // balance), the rest of the run must not keep sending: eight judgments are in flight at a time,
  // and a queue behind them.
  #stopped: ProviderError | undefined;
  #answered = 0; // answers that could be read, not merely HTTP 200s
  #unusable = 0; // answers that could not, while none has been read
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #deadline: number;
  readonly #maxRequests: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(given: Endpoint, options: ClientOptions = {}) {
    // A host this table does not hold has no Jev name and no fixed address to be held to: refused,
    // rather than letting `"constructor"` or a cast string through with an undefined model.
    if (typeof given.host !== "string" || !Object.hasOwn(HOSTS, given.host)) throw new EndpointError("an endpoint must be one of the known hosts");
    // A copy, frozen: changing the caller's object afterwards cannot move the key to another address.
    const endpoint: Readonly<Endpoint> = Object.freeze({ host: given.host, url: given.url, token: given.token });
    // A named host is reached at its own address and nowhere else, however the endpoint was built.
    const fixed = endpoint.host === "typesafe" || endpoint.host === "vercel" ? FIXED_URL[endpoint.host] : undefined;
    if (fixed !== undefined && endpoint.url !== fixed) throw new EndpointError(`${hostName(endpoint.host)} is only reached at ${fixed}`);
    if (endpoint.host === "cloudflare" && !CLOUDFLARE_URL.test(endpoint.url)) {
      throw new EndpointError("Cloudflare Workers AI is only reached at https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run");
    }
    this.#endpoint = endpoint;
    this.origin = new URL(endpoint.url).origin;
    this.host = endpoint.host;
    this.where = `${hostName(endpoint.host)} (${this.origin})`;
    this.model = jevModel(endpoint.host);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    this.#maxRequests = options.maxRequests ?? Number.POSITIVE_INFINITY;
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#now = options.now ?? Date.now;
  }

  /**
   * What the endpoint said, fit to print. The query string goes too: an endpoint that echoes the
   * request it was sent (a plain 404 page does) would otherwise hand back a key kept in the URL.
   */
  #say(text: string, limit?: number): string {
    const query = new URL(this.#endpoint.url).search;
    const cleaned = query === "" ? text : text.split(query).join("?[REDACTED QUERY]");
    return fromEndpoint(cleaned, this.#endpoint.token, limit);
  }

  /** The errors that make every later request pointless, thrown from then on without sending. */
  #latch(error: ProviderError): ProviderError {
    if (error.kind === "endpoint" || error.kind === "auth" || error.kind === "payment") this.#stopped ??= error;
    return error;
  }

  /** Waits before a retry, unless the wait would run past the deadline. */
  async #wait(ms: number): Promise<void> {
    if (ms >= this.#deadline - this.#now()) throw new ProviderError("budget", "time limit reached before the next retry");
    await this.#sleep(ms);
  }

  /** A judgment request in this host's documented shape, asking for Jev under this host's name. */
  request(state: unknown, questions: unknown): Record<string, unknown> {
    return HOSTS[this.host].shape === "workers-ai" ? { model: this.model, input: { state, questions } } : { model: this.model, state, questions };
  }

  /**
   * POSTs `body` to the endpoint and returns the parsed JSON. Retries 429, 5xx and 529. `options`
   * overrides the per-call timeout and retries: a long generation needs more time per attempt and
   * fewer attempts than a typed judgment.
   */
  async post(body: unknown, options: { timeoutMs?: number; maxRetries?: number } = {}): Promise<unknown> {
    // Before the stop latch, before the budget, before anything: a request for another model does
    // not leave this process, is not counted, and does not end the run for the requests that are
    // right. The check is on the body that is about to be serialised, not on what a caller meant.
    const model = (body as { model?: unknown } | null)?.model;
    if (model !== this.model) {
      throw new ProviderError("refused", `this tool sends only ${this.model} to ${hostName(this.host)}; a request for ${typeof model === "string" ? model : "no model at all"} was refused before anything was sent`);
    }
    if (this.#stopped) throw this.#stopped;
    const url = this.#endpoint.url;
    const payload = JSON.stringify(body);
    const size = Buffer.byteLength(payload, "utf8");
    const maxRetries = options.maxRetries ?? this.#maxRetries;
    for (let attempt = 0; ; attempt++) {
      const remaining = this.#deadline - this.#now();
      if (remaining <= 0) throw new ProviderError("budget", "time limit reached");
      if (this.sent.requests + 1 > this.#maxRequests) throw new ProviderError("budget", `request limit reached (${this.#maxRequests})`);
      if (this.sent.bytes + size > this.#maxBytes) throw new ProviderError("budget", `byte limit reached (${this.#maxBytes})`);
      const timeout = Math.min(options.timeoutMs ?? this.#timeoutMs, remaining);
      let response: Response;
      let text: string;
      try {
        this.sent.requests += 1;
        this.sent.bytes += size;
        response = await this.#fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#endpoint.token}`, "Content-Type": "application/json" },
          body: payload,
          // Never follow a redirect: the token would go with it, and a run endpoint does not move.
          redirect: "manual",
          signal: AbortSignal.timeout(timeout),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw this.#latch(new ProviderError("endpoint", `${this.where} redirected the request (${response.status}); it is not a Jev endpoint`, response.status, this.where));
        }
        if (RETRYABLE.has(response.status) && attempt < maxRetries) {
          await response.body?.cancel();
          await this.#wait(retryAfter(response) ?? backoff(attempt));
          continue;
        }
        text = await response.text(); // reading the body can time out as well
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (attempt < maxRetries) {
          await this.#wait(backoff(attempt));
          continue;
        }
        // The exception's own text is not printed: an invalid header value puts the whole token in it.
        throw new ProviderError(timedOut ? "timeout" : "network", timedOut ? `no answer from ${this.where} within ${timeout} ms` : `the request to ${this.where} could not be sent`, undefined, this.where);
      }

      const say = (t: string, limit?: number) => this.#say(t, limit);
      // One unusable answer is about one packet (too large, say). A second one, on a different
      // packet, with none read yet, is about the endpoint: the URL runs something else, or nothing.
      const unusable = (kind: ProviderErrorKind, message: string, status?: number): ProviderError => {
        const twice = this.#answered === 0 && ++this.#unusable >= 2;
        const because = twice ? "; nothing it was sent has been answered, so this is not a Jev endpoint" : "";
        return this.#latch(new ProviderError(twice ? "endpoint" : kind, `${message}${because}`, status, this.where));
      };

      if (!response.ok) {
        const kind = kindOf(response.status);
        // A rate limit or a server error is the endpoint saying "not now", not "not here".
        if (kind === "rate_limited" || kind === "server") throw this.#latch(new ProviderError(kind, `${this.where} answered ${response.status}: ${say(text)}`, response.status, this.where));
        throw unusable(kind, `${this.where} answered ${response.status}: ${say(text)}`, response.status);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw unusable("bad_response", `${this.where} returned something other than JSON: ${say(text, 120)}`, response.status);
      }
      if (json && typeof json === "object" && (json as { success?: unknown }).success === false) {
        const errors = (json as { errors?: { message?: string }[] }).errors;
        throw unusable("bad_response", `${this.where} reported failure: ${say(errors?.[0]?.message ?? "no message")}`, response.status);
      }
      this.#answered += 1;
      return json;
    }
  }
}

function kindOf(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 404 || status === 405) return "endpoint"; // nothing runs models here
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
