import { useEffect, useState, type ReactElement } from 'react';
import type { AuditEventType, AuditLogEntry } from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';

/** Section 6.8 - Audit & Compliance: query the immutable log. */
export function AuditLog(): ReactElement {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [eventType, setEventType] = useState('');

  async function refresh(): Promise<void> {
    // Free-text filter box; the backend does an exact string match, so an unknown
    // value just returns no rows rather than erroring.
    setEntries(
      await client.queryAuditLog({ eventType: (eventType || undefined) as AuditEventType | undefined, limit: 200 }),
    );
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Audit Log</h1>
          <p className="page-subtitle">Section 6.8 - every agent action, policy decision, and approval is logged immutably.</p>
        </div>
        <a className="secondary-btn" href="/api/v1/audit-log/export.csv">
          Export CSV
        </a>
      </div>

      <div className="card">
        <label>
          Filter by event type
          <input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="e.g. TRANSACTION_EXECUTED" />
        </label>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.timestamp).toLocaleString()}</td>
                <td className="mono">{e.eventType}</td>
                <td>{e.actorType === 'user' ? (e.actorUserId ?? 'user') : e.actorType}</td>
                <td>{e.summary}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-row">
                  No audit entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
