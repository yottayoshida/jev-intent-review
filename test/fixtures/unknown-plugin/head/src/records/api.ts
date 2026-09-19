import { audit } from "../audit/log.ts";
import { deleteRecord, findRecord } from "./store.ts";

export function removeRecord(id: string, requestedBy: string): boolean {
  const record = findRecord(id);
  if (!record || record.owner !== requestedBy) return false;
  audit("delete", id);
  return deleteRecord(id);
}
