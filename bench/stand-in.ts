// A Jev endpoint on localhost that bills nothing. It speaks the Workers AI run request the command
// sends to JEV_API_URL. Nothing it returns steers what a run sends (`selectSites` finishes before the
// first request and asks no model; the observation question is sent whatever the mapping answered).
//
// `first` answers every question with its first choice at 0.9 — what `bench/packet-reuse.ts`
// recorded its v1 logs with. `hashed` derives the choice and its probability from the request, so
// two different requests get different answers: a ledger that returned one request's answer for
// another would show in the report (ADR 0013).

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

/** Long enough that it cannot appear in a packet by accident, which would make the trace refuse every entry. */
export const STAND_IN_TOKEN = "stand-in-1d3f5a79c4b2e86097fd1a4c6b8e2d05f7a93c1b4e6d8f0a2c4e6b8d0f2a4c6e";

export interface StandIn {
  url: string;
  close: () => void;
  requests: () => number;
}

/**
 * `port` 0 takes any free port. A run that keeps answers keys them on the endpoint's origin, port
 * included, so two runs that must share answers need the same port.
 */
export function standIn(answers: "first" | "hashed" = "first", port = 0): Promise<StandIn> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests += 1;
      let out: Record<string, unknown> = {};
      try {
        const input = (JSON.parse(body) as { input?: { state?: unknown; questions?: Record<string, { criteria?: Record<string, string> }> } }).input;
        const questions = input?.questions ?? {};
        out = Object.fromEntries(
          Object.entries(questions).map(([key, question]) => {
            const choices = Object.keys(question.criteria ?? {});
            if (choices.length === 0) return [key, { choice: "unknown", probabilities: {} }];
            let index = 0;
            let top = 0.9;
            if (answers === "hashed") {
              const h = createHash("sha256").update(JSON.stringify([key, input?.state, question])).digest();
              index = (h[0] as number) % choices.length;
              // Between 0.50 and 0.99, so some land under the bar of 0.6 and some over it.
              top = 0.5 + ((h[1] as number) % 50) / 100;
            }
            const rest = (1 - top) / Math.max(1, choices.length - 1);
            const probabilities = Object.fromEntries(choices.map((c, i) => [c, i === index ? top : rest]));
            return [key, { choice: choices[index], probabilities }];
          }),
        );
      } catch {
        // A body this cannot read is answered with nothing, and the run reports the place unanswered.
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { state: "Completed", result: { answers: out } } }));
    });
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}/run`, close: () => server.close(), requests: () => requests });
    });
  });
}
