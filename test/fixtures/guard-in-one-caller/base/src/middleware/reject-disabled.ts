import type { Next, Request, Response } from "../http.ts";
import { findApiKey, findUserById } from "../users/repo.ts";

// Stops a request whose API key belongs to a disabled user before the route handler runs.
export function rejectDisabledUsers(req: Request, res: Response, next: Next): void {
  const record = findApiKey(req.header("x-api-key") ?? "");
  const user = record ? findUserById(record.userId) : undefined;
  if (user?.disabledAt) {
    res.status(403).send("account disabled");
    return;
  }
  next();
}
