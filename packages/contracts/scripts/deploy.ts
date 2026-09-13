import { ethers, network } from 'hardhat';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Deploys AgentSubWalletFactory to whichever network Hardhat is pointed at
 * (`--network baseSepolia`) and writes the address + tx hash to
 * deployments/<network>.json so the backend / docs can reference it.
 */
async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployer configured - is PRIVATE_KEY set in .env?');

  console.log(`Deploying on ${network.name} as ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error('Deployer has zero balance - fund it from a faucet before deploying.');
  }

  const Factory = await ethers.getContractFactory('AgentSubWalletFactory');
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const deployTx = factory.deploymentTransaction();

  console.log('AgentSubWalletFactory deployed at:', factoryAddress);
  console.log('Deployment tx:', deployTx?.hash);

  const record = {
    network: network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    factory: {
      address: factoryAddress,
      deployTxHash: deployTx?.hash,
    },
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, '..', 'deployments', `${network.name}.json`);
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`Wrote deployment record to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
