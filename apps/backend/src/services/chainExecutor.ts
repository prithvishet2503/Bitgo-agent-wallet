import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';

/**
 * Where actual signing and broadcasting happen.
 *
 * This deliberately diverges from wallet-platform's real split: there, signing
 * goes through a narrow KMS/MPC interface (`SingleSigKmsProvider`) and the signed
 * tx is handed off via `SendQueue` to a *separate* service (a Kafka worker /
 * indexer) that actually broadcasts it. Here, by design, the same backend
 * process does both - `scheduler/sendQueueWorker.ts` dequeues an entry and calls
 * straight into this module, which holds the private key, signs, and submits to
 * the chain in one step. There is no second service; the SendQueue still exists
 * (Section: build-and-queue, never inline in the HTTP request) purely to keep
 * chain latency off the request path, not to hand work to another service.
 *
 * Two implementations:
 * - `MockChainExecutor` (default) - no network calls, fake addresses/tx hashes,
 *   so the app runs standalone with no external dependency.
 * - `RealChainExecutor` - real ethers.js calls against the AgentSubWalletFactory
 *   / AgentSubWallet contracts deployed to Sepolia (packages/contracts).
 *
 * Real mode activates only when CHAIN_RPC_URL, CHAIN_SIGNER_PRIVATE_KEY, and
 * AGENT_SUB_WALLET_FACTORY_ADDRESS are all set (see .env.example) - otherwise
 * the app falls back to the mock, so it still runs with zero setup.
 */

export interface DeploySubWalletResult {
  address: string;
  txHash: string;
}

export interface ExecuteTransactionResult {
  txHash: string;
}

export interface ChainExecutor {
  readonly mode: 'mock' | 'real';
  /** Deploys (mock) or actually deploys on-chain (real) the smart-contract
   * account for one agent sub-wallet. `subWalletId` seeds a deterministic
   * CREATE2 salt in real mode, so re-running deployment for the same id is
   * idempotent at the address level even if it's never actually re-run. */
  deploySubWallet(input: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult>;
  /** Executes one already-approved transaction from a deployed sub-wallet. In
   * real mode this calls the sub-wallet contract's owner-gated `execute()` with
   * zero value and empty calldata - a real, on-chain, gas-paying transaction
   * that proves the sign-and-broadcast path end-to-end, without moving real
   * funds (the PRD's `valueUsd` is a backend-tracked ledger figure, not a wei
   * amount - see root README for why this is a deliberate scoping choice). */
  executeTransaction(input: { subWalletAddress: string; to: string; transactionId: string }): Promise<ExecuteTransactionResult>;
}

export class MockChainExecutor implements ChainExecutor {
  readonly mode = 'mock' as const;

  async deploySubWallet({ subWalletId }: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult> {
    return {
      address: `0xagent${subWalletId.slice(-12)}`,
      txHash: `0xmock_${randomUUID().replace(/-/g, '')}`,
    };
  }

  async executeTransaction(): Promise<ExecuteTransactionResult> {
    return { txHash: `0xmock_${randomUUID().replace(/-/g, '')}` };
  }
}

const FACTORY_ABI = [
  'function deployWallet(address owner, string agentName, bytes32 salt) returns (address)',
  'function computeAddress(address owner, string agentName, bytes32 salt) view returns (address)',
];

const AGENT_SUB_WALLET_ABI = ['function execute(address to, uint256 value, bytes data) returns (bytes)'];

export class RealChainExecutor implements ChainExecutor {
  readonly mode = 'real' as const;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly factory: ethers.Contract;
  /** Serializes every write against this wallet. The SendQueue worker fires
   * entries concurrently (multiple deployments/broadcasts in one tick); one
   * EOA sending more than one transaction at a time without sequencing its own
   * nonces will race and produce "nonce too low" / stuck-replacement errors, so
   * every send() call below chains onto this instead of running in parallel. */
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(rpcUrl: string, privateKey: string, factoryAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.factory = new ethers.Contract(factoryAddress, FACTORY_ABI, this.wallet);
  }

  get signerAddress(): string {
    return this.wallet.address;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.sendQueue.then(fn, fn);
    // Swallow rejections in the chain itself (the caller still sees them via
    // `result`) so one failed send doesn't permanently wedge every send after it.
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  async deploySubWallet({ subWalletId, agentName }: { subWalletId: string; agentName: string }): Promise<DeploySubWalletResult> {
    // Deterministic per-sub-wallet salt so the on-chain address is derivable
    // from our own internal id (mirrors wallet-platform predicting a forwarder
    // address via CREATE2 before it exists).
    const salt = ethers.id(subWalletId);
    return this.serialize(async () => {
      const tx = await this.factory.deployWallet(this.wallet.address, agentName, salt);
      const receipt = await tx.wait();
      const address: string = await this.factory.computeAddress(this.wallet.address, agentName, salt);
      return { address, txHash: receipt.hash };
    });
  }

  async executeTransaction({
    subWalletAddress,
    to,
  }: {
    subWalletAddress: string;
    to: string;
    transactionId: string;
  }): Promise<ExecuteTransactionResult> {
    if (!ethers.isAddress(to)) {
      throw new Error(`"${to}" is not a valid on-chain address - real chain mode requires a real destination address`);
    }
    return this.serialize(async () => {
      const subWallet = new ethers.Contract(subWalletAddress, AGENT_SUB_WALLET_ABI, this.wallet);
      const tx = await subWallet.execute(to, 0n, '0x');
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    });
  }
}

function buildChainExecutor(): ChainExecutor {
  const rpcUrl = process.env.CHAIN_RPC_URL;
  const privateKey = process.env.CHAIN_SIGNER_PRIVATE_KEY;
  const factoryAddress = process.env.AGENT_SUB_WALLET_FACTORY_ADDRESS;

  if (rpcUrl && privateKey && factoryAddress) {
    const executor = new RealChainExecutor(rpcUrl, privateKey, factoryAddress);
    // eslint-disable-next-line no-console
    console.log(`[chainExecutor] REAL mode - signing/broadcasting as ${executor.signerAddress} via ${rpcUrl}`);
    // eslint-disable-next-line no-console
    console.log(`[chainExecutor] AgentSubWalletFactory: ${factoryAddress}`);
    return executor;
  }

  // eslint-disable-next-line no-console
  console.log('[chainExecutor] MOCK mode - set CHAIN_RPC_URL, CHAIN_SIGNER_PRIVATE_KEY, and AGENT_SUB_WALLET_FACTORY_ADDRESS to go live');
  return new MockChainExecutor();
}

export const chainExecutor: ChainExecutor = buildChainExecutor();
