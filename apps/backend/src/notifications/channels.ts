import type { ApprovalChannel, ApprovalRequest } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.5 - Multi-Channel Approval + Section 12.7 - budget alerts.
 * "Approval requests deliverable to: BitGo web console, mobile push (existing
 * BitGo mobile app), Slack (v1), Telegram/Discord (fast-follow)."
 *
 * The web console channel needs no delivery step (approvers see pending
 * requests by querying the API/UI directly). Slack is now a real webhook POST
 * when SLACK_WEBHOOK_URL is configured (still logged to console regardless,
 * and delivery failures never break the governance pipeline - a notification
 * outage must not wedge transaction submission). Mobile push remains a
 * structured log line standing in for a push provider.
 */

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? null;
const SLACK_TIMEOUT_MS = 5000;

/** Fire-and-forget Slack delivery. Never throws; returns whether a delivery
 * was attempted and succeeded. */
async function postToSlack(text: string): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications] Slack delivery failed:', err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Deliver an approval request to every non-console channel. */
export function notify(channels: ApprovalChannel[], approval: ApprovalRequest, agentName: string): void {
  for (const channel of channels) {
    if (channel === 'console') continue; // no push needed; visible via API/UI directly
    const line =
      `[approval-request via ${channel}] ${approval.summaryText || `Agent "${agentName}" requests ${approval.typedPayload.message.functionDescription}`}` +
      ` - approve/deny request ${approval.id} (expires ${approval.timeoutAt})`;
    // eslint-disable-next-line no-console
    console.log(line);
    if (channel === 'slack') void postToSlack(line);
  }
}

/** Section 12.7 - proactive budget alert. Delivered on every configured
 * channel: console always, Slack webhook when configured (mobile push when a
 * provider exists). */
export function notifyAlert(text: string): void {
  // eslint-disable-next-line no-console
  console.log(`[alert] ${text}`);
  void postToSlack(text);
}
