import { ethers } from 'ethers';
import { DklsDsg, DklsTypes, DklsUtils } from '@bitgo/sdk-lib-mpc';

/**
 * Real threshold-ECDSA MPC signing via BitGo's own audited DKLS
 * implementation (`@bitgo/sdk-lib-mpc` - the same library BitGo's production
 * TSS wallets use for ECDSA coins). Unlike `keyCustody.ts`'s Shamir's Secret
 * Sharing (which reconstructs the complete private key transiently in order
 * to sign), this **never assembles the full private key anywhere, in any
 * process, at any point**: two parties, each holding only their own DKG key
 * share (see `scripts/generateMpcKeys.ts`), run a multi-round Distributed
 * Signature Generation (DSG) protocol that produces a valid ECDSA signature
 * through message-passing alone.
 *
 * `DklsMpcSigner` is a real `ethers.AbstractSigner` - it drops straight into
 * `ethers.Contract(..., signer)` / `signer.sendTransaction(...)` exactly like
 * `ethers.Wallet`, because `ethers.Contract` only ever calls the standard
 * `Signer` interface (`populateTransaction`, `signTransaction`,
 * `sendTransaction`), never anything Wallet-specific.
 *
 * For this prototype both parties' shares live in the same backend process
 * (env vars `CHAIN_MPC_KEY_SHARE_A` / `_B`), so it needs no separate service
 * to run - but the "full key never exists anywhere" property is a genuine
 * fact about the algorithm, not a demo shortcut: even with both parties in
 * one process today, no single value anywhere in memory is ever the complete
 * private key. Moving Party B's share (and its half of every DSG ceremony)
 * to a genuinely separate process/service later is a deployment-topology
 * change, not a cryptographic one - identical to how BitGo's own
 * User/Backup/BitGo TSS parties run as separate systems in production.
 */
export class DklsMpcSigner extends ethers.AbstractSigner {
  constructor(
    private readonly shareA: Buffer,
    private readonly shareB: Buffer,
    private readonly address: string,
    provider?: ethers.Provider | null,
  ) {
    super(provider ?? null);
  }

  connect(provider: ethers.Provider | null): DklsMpcSigner {
    return new DklsMpcSigner(this.shareA, this.shareB, this.address, provider);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  /** Populates the transaction (nonce/gas/chainId - inherited from
   * AbstractSigner, needs `this.provider`), computes its correct pre-image
   * hash for the tx type, runs a full 5-round DSG ceremony between two fresh
   * `Dsg` sessions (one per party's persisted share) to sign that hash, then
   * determines the recovery id the same way any ECDSA-recovery-based chain
   * requires (try both, keep whichever recovers to our known address) and
   * attaches the result. */
  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const populated = await this.populateTransaction(tx);
    delete (populated as { from?: unknown }).from;
    const unsignedTx = ethers.Transaction.from(populated as ethers.TransactionLike);
    const digest = unsignedTx.unsignedHash;
    const digestBytes = Buffer.from(ethers.getBytes(digest));

    const dsgA = new DklsDsg.Dsg(this.shareA, 0, 'm', digestBytes);
    const dsgB = new DklsDsg.Dsg(this.shareB, 1, 'm', digestBytes);
    // Reuses BitGo's own tested round-by-round orchestration (sdk-lib-mpc's
    // `executeTillRound` helper) rather than re-deriving the message-passing
    // sequence ourselves - this is security-critical protocol code.
    const sig = (await DklsUtils.executeTillRound(5, dsgA, dsgB)) as { R: Uint8Array; S: Uint8Array };
    const r = ethers.hexlify(sig.R);
    const s = ethers.hexlify(sig.S);

    const signature = this.recoverSignature(digest, r, s);
    if (!signature) {
      throw new Error('DklsMpcSigner: could not determine a valid recovery id for the produced signature');
    }

    unsignedTx.signature = signature;
    return unsignedTx.serialized;
  }

  private recoverSignature(digest: string, r: string, s: string): ethers.Signature | undefined {
    for (const v of [27, 28]) {
      try {
        const recoveredPubKey = ethers.SigningKey.recoverPublicKey(digest, { r, s, v });
        if (ethers.computeAddress(recoveredPubKey).toLowerCase() === this.address.toLowerCase()) {
          return ethers.Signature.from({ r, s, v });
        }
      } catch {
        // wrong recovery id for this signature - try the other one
      }
    }
    return undefined;
  }

  async signMessage(): Promise<string> {
    throw new Error('DklsMpcSigner: signMessage is not implemented (transaction signing only)');
  }

  async signTypedData(): Promise<string> {
    throw new Error('DklsMpcSigner: signTypedData is not implemented (transaction signing only)');
  }
}

/** Derives the Ethereum address a DKG key share's public key corresponds to -
 * both parties' shares must derive the same address (they're two halves of
 * the same keypair). */
export function deriveAddressFromKeyShare(keyShare: Buffer): string {
  const commonKeychain = DklsTypes.getCommonKeychain(keyShare);
  const compressedPubKey = `0x${commonKeychain.slice(0, 66)}`;
  return ethers.computeAddress(compressedPubKey);
}
