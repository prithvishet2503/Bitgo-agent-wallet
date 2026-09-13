import { ethers, network } from 'hardhat';

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  if (!signer) {
    console.log('No signer configured - is PRIVATE_KEY set in .env?');
    return;
  }
  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`Address: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH (${network.name})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
