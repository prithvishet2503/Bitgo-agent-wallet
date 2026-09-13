import { ethers } from 'ethers';
import { combine } from 'shamir-secret-sharing';
import { DklsMpcSigner, deriveAddressFromKeyShare } from './mpcSigner.js';

/**
 * Custody strategies for the backend's chain-signing key, from weakest to
 * strongest - all implement the same `KeySource` interface so
 * `chainExecutor.ts` doesn't need to know which one is active:
 *
 * - `StaticKeySource` - one raw private key in `.env`. Simplest, single point
 *   of storage.
 * - `ShamirKeySource` - M-of-N Shamir's Secret Sharing (the independently
 *   audited `shamir-secret-sharing` library, Cure53 + Zellic). Removes the
 *   single point of storage and doesn't keep the key resident between
 *   operations, but still reconstructs the complete private key transiently
 *   to sign. Generate shares with `npm run split-key`.
 * - `MpcKeySource` - real threshold-ECDSA MPC (BitGo's own audited DKLS
 *   implementation, `@bitgo/sdk-lib-mpc` - see `mpcSigner.ts`). Never
 *   assembles the full private key anywhere, at any point, in any process -
 *   two parties sign cooperatively via message-passing alone. Generate
 *   shares with `npm run generate-mpc-keys`.
 *
 * Configure via `CHAIN_SIGNER_PRIVATE_KEY`, `CHAIN_SIGNER_KEY_SHARES`, or
 * `CHAIN_MPC_KEY_SHARE_A`/`_B` respectively (see `.env.example`); optionally
 * verify any of them against `CHAIN_SIGNER_EXPECTED_ADDRESS`.
 */
export interface KeySource {
  /** Resolved once at startup (and re-verified on every reconstruction, for
   * Shamir/MPC sources) - safe to log/display, never the key itself. */
  readonly signerAddress: string;
  readonly description: string;
  /** Returns an `ethers.Signer` connected to `provider` - `ethers.Wallet` for
   * the key-holding sources, `DklsMpcSigner` for real MPC. `chainExecutor.ts`
   * only ever calls the standard `ethers.Signer` interface on the result
   * (`sendTransaction`, and via `ethers.Contract`), so it works identically
   * either way. */
  getWallet(provider: ethers.Provider): Promise<ethers.Signer>;
}

export class StaticKeySource implements KeySource {
  readonly signerAddress: string;
  readonly description = 'single hot key (CHAIN_SIGNER_PRIVATE_KEY)';

  constructor(private readonly privateKey: string) {
    this.signerAddress = new ethers.Wallet(privateKey).address;
  }

  async getWallet(provider: ethers.Provider): Promise<ethers.Signer> {
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

  async getWallet(provider: ethers.Provider): Promise<ethers.Signer> {
    const key = await reconstructPrivateKey(this.shareHexes);
    return new ethers.Wallet(key, provider);
  }
}

export class MpcKeySource implements KeySource {
  readonly description =
    'Real threshold-ECDSA MPC (BitGo DKLS via @bitgo/sdk-lib-mpc, 2-of-2) - full key never assembled';

  private constructor(
    private readonly shareA: Buffer,
    private readonly shareB: Buffer,
    readonly signerAddress: string,
  ) {}

  /** Both shares' public keys must agree with each other (they're two halves
   * of one DKG ceremony) and, if given, with `expectedAddress`. Unlike
   * Shamir reconstruction, deriving the address from a DKLS share never
   * touches the private scalar at all, so this needs no "discard after
   * verifying" step - there's nothing sensitive to discard. */
  static create(shareA: Buffer, shareB: Buffer, expectedAddress?: string): MpcKeySource {
    const addressFromA = deriveAddressFromKeyShare(shareA);
    const addressFromB = deriveAddressFromKeyShare(shareB);
    if (addressFromA.toLowerCase() !== addressFromB.toLowerCase()) {
      throw new Error('CHAIN_MPC_KEY_SHARE_A and _B do not correspond to the same DKG ceremony');
    }
    if (expectedAddress && addressFromA.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(
        `MPC key shares resolve to ${addressFromA}, not CHAIN_SIGNER_EXPECTED_ADDRESS (${expectedAddress})`,
      );
    }
    return new MpcKeySource(shareA, shareB, addressFromA);
  }

  async getWallet(provider: ethers.Provider): Promise<ethers.Signer> {
    return new DklsMpcSigner(this.shareA, this.shareB, this.signerAddress, provider);
  }
}

async function reconstructPrivateKey(shareHexes: string[]): Promise<string> {
  const shares = shareHexes.map((hex) => ethers.getBytes(hex));
  const secretBytes = await combine(shares);
  return ethers.hexlify(secretBytes);
}
