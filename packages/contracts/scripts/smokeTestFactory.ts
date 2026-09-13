import { ethers } from 'hardhat';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const deployment = JSON.parse(readFileSync(path.join(__dirname, '..', 'deployments', 'sepolia.json'), 'utf-8'));

/** End-to-end smoke test against the deployed factory: predict an address,
 * deploy a real AgentSubWallet through it, confirm the prediction matched, and
 * exercise the owner-gated execute() path. */
async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractAt('AgentSubWalletFactory', deployment.factory.address);

  const owner = deployer.address; // BitGo's signer, in this demo just the deployer
  const agentName = 'Smoke Test Bot';
  const salt = ethers.id('smoke-test-1');

  const predicted = await factory.computeAddress(owner, agentName, salt);
  console.log('Predicted wallet address:', predicted);

  const tx = await factory.deployWallet(owner, agentName, salt);
  const receipt = await tx.wait();
  console.log('deployWallet tx:', tx.hash, 'status:', receipt?.status);

  const code = await ethers.provider.getCode(predicted);
  console.log('Bytecode at predicted address:', code === '0x' ? 'NONE (mismatch!)' : `${code.length} chars (matches)`);

  const wallet = await ethers.getContractAt('AgentSubWallet', predicted);
  console.log('On-chain owner:', await wallet.owner());
  console.log('On-chain agentName:', await wallet.agentName());

  // Exercise execute(): send 0 ETH to the deployer as a trivial owner-gated call.
  const execTx = await wallet.execute(deployer.address, 0, '0x');
  const execReceipt = await execTx.wait();
  console.log('execute() tx:', execTx.hash, 'status:', execReceipt?.status);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
