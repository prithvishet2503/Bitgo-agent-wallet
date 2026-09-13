import { randomUUID } from 'node:crypto';
import {
  type AuditEventType,
  type AuditLogEntry,
  type AuditLogQuery,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import { db } from '../store/db.js';

/**
 * Section 6.8 - Audit & Compliance.
 * Every agent action (attempted and executed), policy decision, approval/denial, and
 * mode change is logged immutably here. Every other service calls `record()` at the
 * point a governed event happens - nothing is logged retroactively or batched.
 */

export interface RecordAuditEventInput {
  enterpriseId: string;
  subWalletId?: string | null;
  eventType: AuditEventType;
  actorUserId?: string | null;
  actorType: 'user' | 'agent' | 'system';
  summary: string;
  metadata?: Record<string, unknown>;
}

export function record(input: RecordAuditEventInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: `audit_${randomUUID()}`,
    enterpriseId: input.enterpriseId,
    subWalletId: input.subWalletId ?? null,
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType,
    summary: input.summary,
    metadata: input.metadata ?? {},
    timestamp: nowIso(),
  };
  // Immutable: entries are only ever appended, never mutated or deleted.
  db.auditLog.push(entry);
  return entry;
}

export function query(q: AuditLogQuery): AuditLogEntry[] {
  const fromMs = q.from ? Date.parse(q.from) : -Infinity;
  const toMs = q.to ? Date.parse(q.to) : Infinity;
  return db.auditLog
    .all()
    .filter((e) => e.enterpriseId === q.enterpriseId)
    .filter((e) => !q.subWalletId || e.subWalletId === q.subWalletId)
    .filter((e) => !q.eventType || e.eventType === q.eventType)
    .filter((e) => {
      const t = Date.parse(e.timestamp);
      return t >= fromMs && t <= toMs;
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, q.limit);
}

/** Section 6.8 - exportable log (CSV / API). SIEM integration is out of scope for
 * this prototype but the shape here is what an exporter would stream. */
export function exportCsv(enterpriseId: string): string {
  const rows = db.auditLog.all().filter((e) => e.enterpriseId === enterpriseId);
  const header = ['id', 'timestamp', 'eventType', 'actorType', 'actorUserId', 'subWalletId', 'summary'];
  const lines = rows.map((r) =>
    [r.id, r.timestamp, r.eventType, r.actorType, r.actorUserId ?? '', r.subWalletId ?? '', JSON.stringify(r.summary)].join(','),
  );
  return [header.join(','), ...lines].join('\n');
}
