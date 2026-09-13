import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';
import { ShamirKeySource, StaticKeySource, type KeySource } from './keyCustody.js';

/**
 * Where actual signing and broadcasting happen.
 *
 * This deliberately diverges from wallet-platform's real split: there, signing
 * goes through a narrow KMS/MPC interface (`SingleSigKmsProvider`) and the signed
 * tx is handed off via `SendQueue` to a *separate* service (a Kafka worker /
 * indexer) that actually broadcasts it. Here, by design, the same backend
 * process does both - `scheduler/sendQueueWorker.ts` dequeues an entry and calls
 * straight into this module, which holds (or reconstructs - see keyCustody.ts)
 * the signing key and submits to the chain in one step. There is no second
 * service; the SendQueue still exists (Section: build-and-queue, never inline
 * in the HTTP request) purely to keep chain latency off the request path, not
 * to hand work to another service.
 *
 * Two implementations:
 * - `MockChainExecutor` (default) - no network calls, fake addresses/tx hashes,
 *   so the app runs standalone with no external dependency.
 * - `RealChainExecutor` - real ethers.js calls against the AgentSubWalletFactory
 *   / AgentSubWallet contracts deployed to Sepolia (packages/contracts).
 *
 * Real mode activates when CHAIN_RPC_URL, AGENT_SUB_WALLET_FACTORY_ADDRESS, and
 * either CHAIN_SIGNER_PRIVATE_KEY or CHAIN_SIGNER_KEY_SHARES are set (see
 * .env.example) - otherwise the app falls back to the mock, so it still runs
 * with zero setup.
 */

export interface DeploySubWalletResult {
  address: string;
  txHash: string;
  fundingTxHash: string | null;
}

export interface ExecuteTransactionResult {
  txHash: string;
  valueWei: string;
}

export interface ChainExecutor {
  readonly mode: 'mock' | 'real';
  /** Deploys (mock) or actually deploys on-chain (real) the smart-contract
   * account for one agent sub-wallet, then funds it with a small amount of
   * real ETH (real mode only) so it has something to actually transfer later.
   * `subWalletId` seeds a deterministic CREATE2 salt in real mode, so
   * re-running deployment for the same id is idempotent at the address level
   * even if it's never actually re-run. */
  deploySubWallet(input: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult>;
  /** Executes one already-approved transaction from a deployed sub-wallet. In
   * real mode this calls the sub-wallet contract's owner-gated `execute()`
   * with a real wei value derived from `valueUsd` (see usdToWei below) - a
   * real, on-chain, gas-paying, value-moving transaction, not a
   * zero-value ping. */
  executeTransaction(input: {
    subWalletAddress: string;
    to: string;
    valueUsd: number;
    transactionId: string;
  }): Promise<ExecuteTransactionResult>;
}

export class MockChainExecutor implements ChainExecutor {
  readonly mode = 'mock' as const;

  async deploySubWallet({ subWalletId }: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult> {
    return {
      address: `0xagent${subWalletId.slice(-12)}`,
      txHash: `0xmock_${randomUUID().replace(/-/g, '')}`,
      fundingTxHash: null,
    };
  }

  async executeTransaction(): Promise<ExecuteTransactionResult> {
    return { txHash: `0xmock_${randomUUID().replace(/-/g, '')}`, valueWei: '0' };
  }
}

const FACTORY_ABI = [
  'function deployWallet(address owner, string agentName, bytes32 salt) returns (address)',
  'function computeAddress(address owner, string agentName, bytes32 salt) view returns (address)',
];

const AGENT_SUB_WALLET_ABI = ['function execute(address to, uint256 value, bytes data) returns (bytes)'];

/**
 * "Real" USD->ETH conversion is intentionally fake (there is no price oracle
 * here) - it exists only to turn a `valueUsd` ledger figure into a genuinely
 * small, genuinely real wei amount that actually moves on-chain, without
 * requiring an economically meaningful amount of testnet ETH. Default: $1 =
 * 0.000001 ETH, i.e. a $1,000 transaction moves 0.001 ETH.
 */
const USD_TO_ETH_RATE = Number(process.env.CHAIN_USD_TO_ETH_RATE ?? '0.000001');
/** How much ETH to fund each newly deployed AgentSubWallet with, so it has a
 * real balance to actually transfer from later. */
const SUB_WALLET_FUNDING_ETH = Number(process.env.CHAIN_SUB_WALLET_FUNDING_ETH ?? '0.0003');
/** Never let a real send take the treasury (backend's own signing wallet)
 * below this floor - funding/execution requests that would breach it degrade
 * gracefully (unfunded deployment, or an on-chain revert that the SendQueue
 * worker already handles as a clean failure) rather than exhausting the
 * wallet's ability to pay gas at all. */
const MIN_TREASURY_RESERVE_ETH = Number(process.env.CHAIN_MIN_TREASURY_RESERVE_ETH ?? '0.005');

function usdToWei(valueUsd: number): bigint {
  const eth = Math.max(0, valueUsd) * USD_TO_ETH_RATE;
  return ethers.parseEther(eth.toFixed(18));
}

export class RealChainExecutor implements ChainExecutor {
  readonly mode = 'real' as const;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly keySource: KeySource;
  private readonly factoryAddress: string;
  /** Serializes every write against this wallet. The SendQueue worker fires
   * entries concurrently (multiple deployments/broadcasts in one tick); one
   * EOA sending more than one transaction at a time without sequencing its own
   * nonces will race and produce "nonce too low" / stuck-replacement errors, so
   * every send() call below chains onto this instead of running in parallel. */
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(rpcUrl: string, keySource: KeySource, factoryAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.keySource = keySource;
    this.factoryAddress = factoryAddress;
  }

  get signerAddress(): string {
    return this.keySource.signerAddress;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.sendQueue.then(fn, fn);
    // Swallow rejections in the chain itself (the caller still sees them via
    // `result`) so one failed send doesn't permanently wedge every send after it.
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  private async treasuryHeadroomWei(reserveWei: bigint): Promise<bigint> {
    const balance = await this.provider.getBalance(this.keySource.signerAddress);
    return balance > reserveWei ? balance - reserveWei : 0n;
  }

  async deploySubWallet({ subWalletId, agentName }: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult> {
    // Deterministic per-sub-wallet salt so the on-chain address is derivable
    // from our own internal id (mirrors wallet-platform predicting a forwarder
    // address via CREATE2 before it exists).
    const salt = ethers.id(subWalletId);
    return this.serialize(async () => {
      const wallet = await this.keySource.getWallet(this.provider);
      const factory = new ethers.Contract(this.factoryAddress, FACTORY_ABI, wallet);

      const tx = await factory.deployWallet(wallet.address, agentName, salt);
      const receipt = await tx.wait();
      const address: string = await factory.computeAddress(wallet.address, agentName, salt);

      let fundingTxHash: string | null = null;
      const fundingWei = ethers.parseEther(String(SUB_WALLET_FUNDING_ETH));
      const reserveWei = ethers.parseEther(String(MIN_TREASURY_RESERVE_ETH));
      const headroom = await this.treasuryHeadroomWei(reserveWei);
      if (fundingWei > 0n && headroom >= fundingWei) {
        try {
          const fundingTx = await wallet.sendTransaction({ to: address, value: fundingWei });
          const fundingReceipt = await fundingTx.wait();
          fundingTxHash = fundingReceipt?.hash ?? fundingTx.hash;
        } catch (err) {
          // A failed funding transfer shouldn't fail the deployment itself -
          // the sub-wallet still exists and can be topped up later; it just
          // can't move real value until then (on-chain execute() calls
          // requiring more balance than it has simply revert, which
          // completeBroadcast already surfaces as a clean SendQueue failure).
          // eslint-disable-next-line no-console
          console.error(`[chainExecutor] Failed to fund new sub-wallet ${address}:`, err);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[chainExecutor] Skipped funding ${address} - treasury headroom too low (reserve floor ${MIN_TREASURY_RESERVE_ETH} ETH)`,
        );
      }

      return { address, txHash: receipt.hash, fundingTxHash };
    });
  }

  async executeTransaction({
    subWalletAddress,
    to,
    valueUsd,
  }: {
    subWalletAddress: string;
    to: string;
    valueUsd: number;
    transactionId: string;
  }): Promise<ExecuteTransactionResult> {
    if (!ethers.isAddress(to)) {
      throw new Error(`"${to}" is not a valid on-chain address - real chain mode requires a real destination address`);
    }
    const valueWei = usdToWei(valueUsd);
    return this.serialize(async () => {
      const wallet = await this.keySource.getWallet(this.provider);
      const subWallet = new ethers.Contract(subWalletAddress, AGENT_SUB_WALLET_ABI, wallet);
      const tx = await subWallet.execute(to, valueWei, '0x');
      const receipt = await tx.wait();
      return { txHash: receipt.hash, valueWei: valueWei.toString() };
    });
  }
}

async function resolveKeySource(): Promise<KeySource | null> {
  const singleKey = process.env.CHAIN_SIGNER_PRIVATE_KEY;
  if (singleKey) return new StaticKeySource(singleKey);

  const sharesRaw = process.env.CHAIN_SIGNER_KEY_SHARES;
  if (sharesRaw) {
    const shareHexes = sharesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return ShamirKeySource.create(shareHexes, process.env.CHAIN_SIGNER_EXPECTED_ADDRESS);
  }

  return null;
}

async function buildChainExecutor(): Promise<ChainExecutor> {
  const rpcUrl = process.env.CHAIN_RPC_URL;
  const factoryAddress = process.env.AGENT_SUB_WALLET_FACTORY_ADDRESS;

  if (rpcUrl && factoryAddress) {
    const keySource = await resolveKeySource();
    if (keySource) {
      const executor = new RealChainExecutor(rpcUrl, keySource, factoryAddress);
      // eslint-disable-next-line no-console
      console.log(`[chainExecutor] REAL mode - custody: ${keySource.description}`);
      // eslint-disable-next-line no-console
      console.log(`[chainExecutor] signing/broadcasting as ${executor.signerAddress} via ${rpcUrl}`);
      // eslint-disable-next-line no-console
      console.log(
        `[chainExecutor] AgentSubWalletFactory: ${factoryAddress} | funding new wallets with ${SUB_WALLET_FUNDING_ETH} ETH | $1 = ${USD_TO_ETH_RATE} ETH`,
      );
      return executor;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    '[chainExecutor] MOCK mode - set CHAIN_RPC_URL, AGENT_SUB_WALLET_FACTORY_ADDRESS, and either CHAIN_SIGNER_PRIVATE_KEY or CHAIN_SIGNER_KEY_SHARES to go live',
  );
  return new MockChainExecutor();
}

export const chainExecutor: ChainExecutor = await buildChainExecutor();
