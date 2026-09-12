import { BitGoAgentWalletClient } from '@bitgo-agent-wallet/sdk';

const STORAGE_KEY = 'bitgo-agent-wallet:apiToken';

export const client = new BitGoAgentWalletClient({
  baseUrl: '/api/v1',
  apiToken: localStorage.getItem(STORAGE_KEY) ?? undefined,
});

export function persistApiToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
  client.setApiToken(token);
}

export function clearApiToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasStoredApiToken(): boolean {
  return Boolean(localStorage.getItem(STORAGE_KEY));
}
