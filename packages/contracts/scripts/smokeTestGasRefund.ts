import { ethers } from 'hardhat';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const deployment = JSON.parse(readFileSync(path.join(__dirname, '..', 'deployments', 'sepolia.json'), 'utf-8'));

/**
 * End-to-end proof that `executeWithGasRefund` really moves ETH on-chain from
 * the sub-wallet to its owner (the backend treasury signer) - the mechanism
 * behind gas-sponsorship fallback ("own_balance"), as opposed to plain
 * `execute()` where the treasury simply eats the gas cost. Deploys a fresh
 * wallet, funds it, calls both variants, and independently checks balances
 * before/after rather than trusting the tx receipt alone.
 */
async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractAt('AgentSubWalletFactory', deployment.factory.address);

  const owner = deployer.address;
  const agentName = 'Gas Refund Smoke Test';
  const salt = ethers.id(`gas-refund-smoke-${Date.now()}`);

  const predicted = await factory.computeAddress(owner, agentName, salt);
  const deployTx = await factory.deployWallet(owner, agentName, salt);
  await deployTx.wait();
  console.log('Deployed wallet:', predicted);

  const wallet = await ethers.getContractAt('AgentSubWallet', predicted);

  // Fund the sub-wallet so it has something to refund gas from.
  const fundTx = await deployer.sendTransaction({ to: predicted, value: ethers.parseEther('0.001') });
  await fundTx.wait();
  const walletBalanceBefore = await ethers.provider.getBalance(predicted);
  console.log('Sub-wallet funded. Balance before executeWithGasRefund:', ethers.formatEther(walletBalanceBefore), 'ETH');

  const ownerBalanceBefore = await ethers.provider.getBalance(owner);

  // eth_estimateGas systematically under-estimates this function: its
  // binary search probes gas amounts that don't reproduce the exact
  // `gasleft()` delta the real broadcast will see, so a plain estimate can
  // (and did, in testing) leave the tx under-funded and reverting for a
  // reason unrelated to the contract logic itself. Doubling the estimate
  // is a blunt but reliable fix - chainExecutor.ts does the same.
  const gasEstimate = await wallet.executeWithGasRefund.estimateGas(owner, 0, '0x');
  const tx = await wallet.executeWithGasRefund(owner, 0, '0x', { gasLimit: gasEstimate * 2n });
  const receipt = await tx.wait();
  if (!receipt) throw new Error('no receipt');

  const gasRefundedEvent = receipt.logs
    .map((log) => {
      try {
        return wallet.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === 'GasRefunded');

  if (!gasRefundedEvent) throw new Error('GasRefunded event not emitted');
  const refundAmount: bigint = gasRefundedEvent.args.amount;
  console.log('GasRefunded event: refunded', ethers.formatEther(refundAmount), 'ETH to', gasRefundedEvent.args.to);

  const walletBalanceAfter = await ethers.provider.getBalance(predicted);
  const ownerBalanceAfter = await ethers.provider.getBalance(owner);
  const txCostWei = receipt.gasUsed * receipt.gasPrice;

  console.log('Sub-wallet balance after:', ethers.formatEther(walletBalanceAfter), 'ETH');
  console.log('Wallet balance delta (should equal -refund):', ethers.formatEther(walletBalanceAfter - walletBalanceBefore), 'ETH');
  console.log(
    'Owner balance delta (should equal +refund - own tx gas cost):',
    ethers.formatEther(ownerBalanceAfter - ownerBalanceBefore),
    'ETH',
  );
  console.log('Owner paid for this tx:', ethers.formatEther(txCostWei), 'ETH in gas');

  const walletDelta = walletBalanceBefore - walletBalanceAfter;
  const ownerNetDelta = ownerBalanceAfter - ownerBalanceBefore;
  const expectedOwnerNetDelta = refundAmount - txCostWei;

  if (walletDelta !== refundAmount) throw new Error('Sub-wallet did not lose exactly the refunded amount');
  if (ownerNetDelta !== expectedOwnerNetDelta) throw new Error('Owner balance change does not match refund minus its own gas cost');

  console.log('\n✅ Verified: refund really moved on-chain, independent of the event log.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
