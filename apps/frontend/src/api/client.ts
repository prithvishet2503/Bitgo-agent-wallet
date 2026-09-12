import { BitGoAgentWalletClient } from '@bitgo-agent-wallet/sdk';

const TOKEN_KEY = 'bitgo-agent-wallet:apiToken';
const ENTERPRISE_KEY = 'bitgo-agent-wallet:enterpriseId';

export const client = new BitGoAgentWalletClient({
  baseUrl: '/api/v1',
  apiToken: localStorage.getItem(TOKEN_KEY) ?? undefined,
  enterpriseId: localStorage.getItem(ENTERPRISE_KEY) ?? undefined,
});

export function persistApiToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  client.setApiToken(token);
}

export function persistEnterpriseId(enterpriseId: string): void {
  localStorage.setItem(ENTERPRISE_KEY, enterpriseId);
  client.setEnterpriseId(enterpriseId);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ENTERPRISE_KEY);
}

export function hasStoredApiToken(): boolean {
  return Boolean(localStorage.getItem(TOKEN_KEY));
}
