import { ethers } from 'ethers';
import { combine } from 'shamir-secret-sharing';

/**
 * M-of-N custody for the backend's chain-signing key, using Shamir's Secret
 * Sharing (the `shamir-secret-sharing` library - independently audited by
 * Cure53 and Zellic) instead of one raw private key sitting in a single
 * `.env` file. Configure via `CHAIN_SIGNER_KEY_SHARES` (comma-separated hex
 * shares) and optionally `CHAIN_SIGNER_EXPECTED_ADDRESS` (verifies
 * reconstruction produced the right key - the library itself does not
 * validate this). Generate shares from an existing key with
 * `npm run split-key` (scripts/splitKey.ts).
 *
 * Honesty check, stated once here rather than at every call site: this
 * genuinely removes any single point of *storage* for the complete key (N
 * shares, none individually usable, ideally held by separate
 * custodians/secret stores in a real deployment) and reconstructs it fresh
 * for every signing operation rather than keeping it resident in memory for
 * the life of the process. It is **not** the same guarantee as the
 * threshold-ECDSA MPC/TSS BitGo actually uses in production, which computes
 * a valid signature via cooperating parties WITHOUT the full private key
 * ever being assembled anywhere, even momentarily. Implementing an audited
 * threshold-ECDSA protocol from scratch is a much larger, security-critical
 * undertaking than fits a prototype; SSS-based custody is the honestly-scoped
 * middle ground between "one hot key" and "real MPC/HSM".
 */
export interface KeySource {
  /** Resolved once at startup (and re-verified on every reconstruction, for
   * Shamir sources) - safe to log/display, never the key itself. */
  readonly signerAddress: string;
  readonly description: string;
  getWallet(provider: ethers.Provider): Promise<ethers.Wallet>;
}

export class StaticKeySource implements KeySource {
  readonly signerAddress: string;
  readonly description = 'single hot key (CHAIN_SIGNER_PRIVATE_KEY)';

  constructor(private readonly privateKey: string) {
    this.signerAddress = new ethers.Wallet(privateKey).address;
  }

  async getWallet(provider: ethers.Provider): Promise<ethers.Wallet> {
    return new ethers.Wallet(this.privateKey, provider);
  }
}

export class ShamirKeySource implements KeySource {
  readonly description: string;

  private constructor(
    private readonly shareHexes: string[],
    readonly signerAddress: string,
  ) {
    this.description = `Shamir's Secret Sharing, ${shareHexes.length} shares configured (CHAIN_SIGNER_KEY_SHARES)`;
  }

  /** Async factory (SSS reconstruction is async) - does one reconstruction up
   * front purely to resolve and optionally verify `signerAddress`, then
   * discards that key; `getWallet()` reconstructs fresh every time it's
   * actually needed to sign. */
  static async create(shareHexes: string[], expectedAddress?: string): Promise<ShamirKeySource> {
    if (shareHexes.length < 2) {
      throw new Error('CHAIN_SIGNER_KEY_SHARES needs at least 2 shares');
    }
    const key = await reconstructPrivateKey(shareHexes);
    const address = new ethers.Wallet(key).address;
    if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `Reconstructed signing key resolves to ${address}, not CHAIN_SIGNER_EXPECTED_ADDRESS (${expectedAddress}) - check your key shares`,
      );
    }
    return new ShamirKeySource(shareHexes, address);
  }

  async getWallet(provider: ethers.Provider): Promise<ethers.Wallet> {
    const key = await reconstructPrivateKey(this.shareHexes);
    return new ethers.Wallet(key, provider);
  }
}

async function reconstructPrivateKey(shareHexes: string[]): Promise<string> {
  const shares = shareHexes.map((hex) => ethers.getBytes(hex));
  const secretBytes = await combine(shares);
  return ethers.hexlify(secretBytes);
}
