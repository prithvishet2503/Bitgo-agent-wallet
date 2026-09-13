import { DklsUtils } from '@bitgo/sdk-lib-mpc';
import { deriveAddressFromKeyShare } from '../src/services/mpcSigner.js';

/**
 * Runs a real 2-of-2 DKLS distributed key generation (DKG) ceremony (BitGo's
 * own audited MPC library, @bitgo/sdk-lib-mpc) and prints the two resulting
 * key shares. Neither share alone can sign or reveal the private key; both
 * are needed for the DSG signing ceremony in mpcSigner.ts.
 *
 * Usage: tsx scripts/generateMpcKeys.ts
 */
async function main(): Promise<void> {
  console.log('Running a real 2-party DKLS DKG ceremony (a few seconds)...\n');
  const [partyA, partyB] = await DklsUtils.generate2of2KeyShares();
  const shareA = partyA.getKeyShare();
  const shareB = partyB.getKeyShare();

  const address = deriveAddressFromKeyShare(shareA);
  const addressB = deriveAddressFromKeyShare(shareB);
  if (address.toLowerCase() !== addressB.toLowerCase()) {
    throw new Error('Internal error: the two generated shares do not agree on an address');
  }

  console.log(`Address: ${address}\n`);
  console.log('Set these in apps/backend/.env (remove CHAIN_SIGNER_PRIVATE_KEY / CHAIN_SIGNER_KEY_SHARES if set):');
  console.log(`CHAIN_MPC_KEY_SHARE_A=${shareA.toString('base64')}`);
  console.log(`CHAIN_MPC_KEY_SHARE_B=${shareB.toString('base64')}`);
  console.log(`CHAIN_SIGNER_EXPECTED_ADDRESS=${address}`);
  console.log(
    '\nFund this address with Sepolia ETH before using it as the treasury signer.\n' +
      "In a real deployment, Party A and Party B's shares (and their half of every signing\n" +
      'ceremony) would run in genuinely separate processes/services - keeping both in one\n' +
      '.env here is a demo simplification, not a limitation of the algorithm itself: even\n' +
      'with both parties in this one process, the complete private key never exists as a\n' +
      'single value anywhere.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
