import { ethers } from 'ethers';
import { split } from 'shamir-secret-sharing';

/**
 * Splits an existing private key into N Shamir shares, M of which are needed
 * to reconstruct it - see services/keyCustody.ts for what this buys you (and
 * what it doesn't). Run once per key you want to move off single-key custody.
 *
 * Usage: tsx scripts/splitKey.ts <privateKeyHex> [numShares=3] [threshold=2]
 */
async function main(): Promise<void> {
  const privateKey = process.argv[2];
  const numShares = Number(process.argv[3] ?? 3);
  const threshold = Number(process.argv[4] ?? 2);

  if (!privateKey) {
    console.error('Usage: tsx scripts/splitKey.ts <privateKeyHex> [numShares=3] [threshold=2]');
    process.exitCode = 1;
    return;
  }

  const wallet = new ethers.Wallet(privateKey);
  const secretBytes = ethers.getBytes(privateKey);
  const shares = await split(secretBytes, numShares, threshold);
  const shareHexes = shares.map((s) => ethers.hexlify(s));

  console.log(`Address: ${wallet.address}`);
  console.log(`Split into ${numShares} shares, ${threshold} required to reconstruct.\n`);
  shareHexes.forEach((hex, i) => console.log(`Share ${i + 1}: ${hex}`));

  console.log('\nSet these in apps/backend/.env (remove CHAIN_SIGNER_PRIVATE_KEY if it was set):');
  console.log(`CHAIN_SIGNER_KEY_SHARES=${shareHexes.join(',')}`);
  console.log(`CHAIN_SIGNER_EXPECTED_ADDRESS=${wallet.address}`);
  console.log(
    '\nIn a real deployment, distribute these shares to separate custodians/secret stores rather than\n' +
      'keeping them all in one .env file - that single file is exactly the single point of failure this is meant to remove.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
