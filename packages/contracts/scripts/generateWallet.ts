import { ethers } from 'hardhat';
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Generates a fresh throwaway deployer wallet for testnet use only and writes
 * its private key to .env (gitignored). Never use this for anything holding
 * real value - it exists purely to pay testnet gas for the demo deployment.
 */
async function main(): Promise<void> {
  const wallet = ethers.Wallet.createRandom();
  const envPath = path.join(__dirname, '..', '.env');

  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  if (existing.includes('PRIVATE_KEY=') && !existing.match(/PRIVATE_KEY=\s*$/m) && !existing.match(/PRIVATE_KEY=\n/)) {
    console.log('A .env with PRIVATE_KEY already exists - not overwriting. Delete it first if you want a new one.');
    console.log('Existing deployer address can be checked with: npm run check-balance');
    return;
  }

  const contents = `PRIVATE_KEY=${wallet.privateKey}\nBASE_SEPOLIA_RPC_URL=https://sepolia.base.org\n`;
  if (existing) {
    appendFileSync(envPath, contents);
  } else {
    writeFileSync(envPath, contents);
  }

  console.log('Generated a new throwaway testnet deployer wallet.');
  console.log('Address (fund this on Base Sepolia):', wallet.address);
  console.log('Private key saved to packages/contracts/.env (gitignored) - never shared, never used for real funds.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
