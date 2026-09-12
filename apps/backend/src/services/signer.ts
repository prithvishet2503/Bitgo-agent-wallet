import { randomUUID } from 'node:crypto';

/**
 * Narrow signing abstraction, mirroring wallet-platform's
 * `SingleSigKmsProvider` (`app/base/kms/abstract/singleSig/SingleSigKmsProvider.ts`):
 * callers (the SendQueue worker) never touch key material directly, only
 * `sign()`. wallet-platform's sole implementation is AWS KMS
 * (`AwsKmsSingleSigProvider`); MPC/TSS wallets go through a separate `keysMPC`
 * module instead of this interface. This prototype has one mock implementation -
 * swapping in a real KMS/MPC signer means implementing this interface and
 * changing the one line that constructs `signer` below, not any caller.
 */
export interface Signer {
  sign(subWalletId: string, payloadDescription: string): Promise<{ signature: string }>;
}

export class MockKmsSigner implements Signer {
  async sign(subWalletId: string, payloadDescription: string): Promise<{ signature: string }> {
    // Deterministic-looking fake signature - stands in for an HSM/MPC signing
    // round trip. Never real key material.
    void subWalletId;
    void payloadDescription;
    return { signature: `0xsig_${randomUUID().replace(/-/g, '')}` };
  }
}

export const signer: Signer = new MockKmsSigner();
