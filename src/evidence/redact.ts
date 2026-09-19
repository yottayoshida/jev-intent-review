// What is never sent to the judgment model. Files are excluded by name before they are read;
// everything that is sent is redacted by content first. Redaction runs before any cutting, so a
// long secret cannot survive by being cut in the middle of its recognisable shape.

import { globToRegExp } from "../config/glob.ts";

// Matched case-insensitively against the whole path.
const SENSITIVE_PATHS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/credentials",
  "**/credentials.json",
  "**/*serviceaccount*.json",
  "**/*service-account*.json",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.htpasswd",
  "**/.dev.vars",
  "**/secrets.*",
].map((glob) => globToRegExp(glob, "i"));

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path));
}

const CONTENT: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED GITLAB TOKEN]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED GOOGLE KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]"],
  // `password = "..."`, `apiKey: '...'`: the name stays, the value goes.
  [
    /\b([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_]*\s*[:=]\s*)(["'`])[^"'`\n]{8,}\2/gi,
    "$1$2[REDACTED]$2",
  ],
  // Long unbroken base64 or hex: keys, certificates, embedded blobs. No judgment needs them.
  [/[A-Za-z0-9+/]{60,}={0,2}/g, "[REDACTED LONG STRING]"],
  [/\b[0-9a-fA-F]{48,}\b/g, "[REDACTED LONG STRING]"],
];

/** The text with every secret-shaped value replaced, and how many were replaced. */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of CONTENT) {
    out = out.replace(pattern, (...args) => {
      count += 1;
      const groups = args.slice(1, -2) as (string | undefined)[];
      return replacement.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? "");
    });
  }
  return { text: out, count };
}

/** Head and tail of `text` within `limit` characters, and whether anything was cut. */
export function cut(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const marker = `\n[... ${text.length - limit} characters cut ...]\n`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.ceil((room * 2) / 3);
  return { text: `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`, truncated: true };
}
