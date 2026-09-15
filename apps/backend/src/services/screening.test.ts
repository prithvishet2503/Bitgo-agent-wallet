import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Static imports cannot work here: db.ts reads PERSISTENCE_MODE and
// screeningService.ts reads SCREENING_FAIL_MODE at module evaluation time, so
// the env assignments must execute before any project module loads (ESM
// static imports hoist above them). Deliberate module-loading boundary per
// the test-file exception.
//
// This file runs with the DEFAULT fail mode (closed) and a network that always
// fails - the fail-closed contract.
process.env.PERSISTENCE_MODE = 'memory';
process.env.SCREENING_FAIL_MODE = ''; // unset -> 'closed' default
globalThis.fetch = (async () => {
  throw new Error('offline test environment');
}) as typeof fetch;

const { db, seedDemoData } = await import('../store/db.js');
const screeningService = await import('./screeningService.js');

beforeEach(() => {
  db.reset();
  seedDemoData();
});

test('REGRESSION: vendor outage holds the transaction in fail-closed mode (default)', async () => {
  const result = await screeningService.screen({ address: '0x9999999999999999999999999999999999999999' });
  assert.equal(result.verdict, 'flagged');
  assert.equal(result.reason, 'SCREENING_UNAVAILABLE');
});

test('demo sanctioned addresses are flagged without any network', async () => {
  const result = await screeningService.screen({ address: '0xsanctioned0001' });
  assert.equal(result.verdict, 'flagged');
  assert.equal(result.reason, 'SANCTIONED_ADDRESS');
});

test('demo malicious-contract addresses are flagged without any network', async () => {
  const result = await screeningService.screen({ address: '0xmalicious0001' });
  assert.equal(result.verdict, 'flagged');
  assert.equal(result.reason, 'KNOWN_MALICIOUS_CONTRACT');
});

test('demo mixer-linked addresses are flagged without any network', async () => {
  const result = await screeningService.screen({ address: '0xmixerlinked0001' });
  assert.equal(result.verdict, 'flagged');
  assert.equal(result.reason, 'MIXER_LINKED');
});

test('status endpoint reports the active fail mode', () => {
  assert.equal(screeningService.getScreeningStatus().failMode, 'closed');
});

test('screenOutgoing: sanctioned destination flagged without any network', async () => {
  const destinationBlocked = await screeningService.screenOutgoing('0xsanctioned0001', null, 'base');
  assert.equal(destinationBlocked.reason, 'SANCTIONED_ADDRESS');
});

test('screenOutgoing (fail-closed): unscreenable destination holds the transaction before the contract is consulted', async () => {
  // With the vendor down and fail-closed active, the destination itself is
  // un-screenable, so the hold fires on the destination - the contract check
  // is moot until the destination can be cleared. Correct precedence, not a
  // bug; the contract-blocked path itself is covered in transaction.test.ts
  // under fail-open, where the destination clears and the contract flags.
  const result = await screeningService.screenOutgoing(
    '0x1111111111111111111111111111111111111111',
    '0xmalicious0001',
    'base',
  );
  assert.equal(result.verdict, 'flagged');
  assert.equal(result.reason, 'SCREENING_UNAVAILABLE');
});
