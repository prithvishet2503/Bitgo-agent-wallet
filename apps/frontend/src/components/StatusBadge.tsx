import type { ReactElement } from 'react';
const TONE_BY_STATUS: Record<string, string> = {
  active: 'tone-good',
  executed: 'tone-good',
  approved: 'tone-good',
  clean: 'tone-good',
  released: 'tone-good',
  suspended: 'tone-bad',
  denied: 'tone-bad',
  expired: 'tone-bad',
  screening_blocked: 'tone-bad',
  simulation_failed: 'tone-bad',
  policy_denied: 'tone-bad',
  flagged: 'tone-bad',
  quarantined: 'tone-bad',
  pending: 'tone-warn',
  pending_approval: 'tone-warn',
  strict: 'tone-neutral',
  bounded_auto: 'tone-info',
};

export function StatusBadge({ value }: { value: string }): ReactElement {
  const tone = TONE_BY_STATUS[value] ?? 'tone-neutral';
  return <span className={`badge ${tone}`}>{value.replace(/_/g, ' ')}</span>;
}
