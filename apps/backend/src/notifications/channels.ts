import type { ApprovalChannel, ApprovalRequest } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.5 - Multi-Channel Approval.
 * "Approval requests deliverable to: BitGo web console, mobile push (existing BitGo
 * mobile app), Slack (v1), Telegram/Discord (fast-follow)."
 *
 * The web console channel needs no delivery step (approvers see pending requests by
 * querying the API/UI directly). Mobile push and Slack are mocked here as
 * structured log lines standing in for a push provider / Slack webhook call -
 * swapping in real delivery only touches this file.
 */
export function notify(channels: ApprovalChannel[], approval: ApprovalRequest, agentName: string): void {
  for (const channel of channels) {
    if (channel === 'console') continue; // no push needed; visible via API/UI directly
    const line = `[approval-request via ${channel}] Agent "${agentName}" wants to ${approval.typedPayload.message.functionDescription} ` +
      `$${approval.typedPayload.message.valueUsd} to ${approval.typedPayload.message.to} on ${approval.typedPayload.message.network} ` +
      `- approve/deny request ${approval.id} (expires ${approval.timeoutAt})`;
    // eslint-disable-next-line no-console
    console.log(line);
  }
}
