import { audit } from "../audit/log.ts";
import { deleteRecord, listRecords } from "../records/store.ts";

export function purgeExpired(now: number): number {
  let removed = 0;
  for (const record of listRecords()) {
    if (record.expiresAt > now) continue;
    audit("delete", record.id);
    if (deleteRecord(record.id)) removed += 1;
  }
  return removed;
}
