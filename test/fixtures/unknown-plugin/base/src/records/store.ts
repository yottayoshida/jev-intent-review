export interface RecordRow {
  id: string;
  owner: string;
  expiresAt: number;
}

const rows = new Map<string, RecordRow>();

export function findRecord(id: string): RecordRow | undefined {
  return rows.get(id);
}

export function listRecords(): RecordRow[] {
  return [...rows.values()];
}

export function deleteRecord(id: string): boolean {
  return rows.delete(id);
}
