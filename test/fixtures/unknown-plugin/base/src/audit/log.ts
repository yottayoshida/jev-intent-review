export interface AuditEntry {
  action: string;
  target: string;
  at: number;
}

const entries: AuditEntry[] = [];

export function audit(action: string, target: string): void {
  entries.push({ action, target, at: Date.now() });
}
