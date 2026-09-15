#!/usr/bin/env bash
#
# x402 Micropayment Demo
#
# Demonstrates the full HTTP 402 Payment Required flow:
#   1. Client requests a protected endpoint without payment → 402
#   2. Server responds with PAYMENT-REQUIRED header
#   3. Client creates a signed payment payload
#   4. Client retries with PAYMENT-SIGNATURE header
#   5. Server verifies, runs the handler, settles, responds 200
#
# Uses X402_DEMO_MODE=true so no real on-chain transactions are needed.
# The demo facilitator accepts any payment payload and returns success.
#
# Usage:
#   cd apps/backend
#   bash scripts/demo-x402.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

DEMO_PORT=4099
BACKEND_PID=""

cleanup() {
  if [ -n "$BACKEND_PID" ]; then
    echo ""
    echo "Stopping backend..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "============================================"
echo "  x402 Micropayment Demo"
echo "============================================"
echo ""
echo "This demo shows the HTTP 402 Payment Required flow."
echo "In demo mode, payments are simulated (no real on-chain txs)."
echo ""

# ── 1. Start the backend in demo mode ──────────────────────────────────────

echo "Step 1: Starting backend in demo mode on port $DEMO_PORT..."
X402_DEMO_MODE=true \
  X402_PRICE_PER_WRITE=0.001 \
  PORT=$DEMO_PORT \
  npx tsx "$BACKEND_DIR/src/index.ts" &
BACKEND_PID=$!

for i in $(seq 1 30); do
  if curl -s "http://localhost:$DEMO_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "  Backend is ready."
echo ""

# Common sub-wallet payload
SUB_WALLET_PAYLOAD='{
  "agentName": "Demo Trading Bot",
  "chain": "ethereum-mainnet",
  "fundingSource": "allocated_balance",
  "allocatedBalanceUsd": 10000,
  "autonomyMode": "bounded_auto"
}'

# ── 2. First request: no payment → 402 ─────────────────────────────────────

echo "Step 2: Making first request WITHOUT payment..."
echo "  POST /api/v1/sub-wallets  (create sub-wallet)"
echo ""

FIRST_RESPONSE=$(mktemp)
FIRST_HTTP_CODE=$(curl -s -o "$FIRST_RESPONSE" -w "%{http_code}" \
  -X POST "http://localhost:$DEMO_PORT/api/v1/sub-wallets" \
  -H 'Authorization: Bearer demo-admin-token' \
  -H 'Content-Type: application/json' \
  -d "$SUB_WALLET_PAYLOAD")

echo "  Response status: $FIRST_HTTP_CODE"
echo ""

if [ "$FIRST_HTTP_CODE" != "402" ]; then
  echo "  Expected 402 but got $FIRST_HTTP_CODE. Response:"
  cat "$FIRST_RESPONSE"
  echo ""
  rm -f "$FIRST_RESPONSE"
  exit 1
fi

echo "  402 Payment Required — as expected!"
echo ""

# Extract and decode the PAYMENT-REQUIRED header
PAYMENT_REQUIRED_HEADER=$(curl -s -D - \
  -X POST "http://localhost:$DEMO_PORT/api/v1/sub-wallets" \
  -H 'Authorization: Bearer demo-admin-token' \
  -H 'Content-Type: application/json' \
  -d "$SUB_WALLET_PAYLOAD" 2>/dev/null \
  | grep -i "^PAYMENT-REQUIRED:" | sed 's/^PAYMENT-REQUIRED: //' | tr -d '\r')

echo "  PAYMENT-REQUIRED header (base64):"
echo "  $PAYMENT_REQUIRED_HEADER"
echo ""

echo "  Decoded payment requirements:"
echo "$PAYMENT_REQUIRED_HEADER" | python3 -c "
import sys, base64, json
data = sys.stdin.read().strip()
if data:
    decoded = base64.b64decode(data).decode('utf-8')
    parsed = json.loads(decoded)
    print(json.dumps(parsed, indent=4))
" 2>/dev/null || echo "  (could not decode)"
echo ""

# ── 3. Second request: with payment → 200 ──────────────────────────────

echo "Step 3: Making second request WITH payment..."
echo ""

# Create a payment payload for demo mode.
# The mock facilitator accepts any payload.
PAYMENT_PAYLOAD=$(python3 -c "
import json, base64
payload = {
    'x402Version': 2,
    'resource': {
        'url': 'http://localhost:$DEMO_PORT/api/v1/sub-wallets',
        'description': 'Create an agent sub-wallet',
        'mimeType': 'application/json'
    },
    'accepted': {
        'scheme': 'exact',
        'network': 'eip155:84532',
        'asset': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        'amount': '1000',
        'payTo': '0x0000000000000000000000000000000000000001',
        'maxTimeoutSeconds': 300,
        'extra': {
            'name': 'USDC',
            'version': '2'
        }
    },
    'payload': {
        'signature': '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        'authorization': {
            'from': '0x0000000000000000000000000000000000000002',
            'to': '0x0000000000000000000000000000000000000001',
            'value': '1000',
            'validAfter': '0',
            'validBefore': '9999999999',
            'nonce': '[SECRET:ethereum-private-key]'
        }
    }
}
print(base64.b64encode(json.dumps(payload).encode()).decode())
")

echo "  Payment payload (base64, sent as PAYMENT-SIGNATURE header):"
echo "  $PAYMENT_PAYLOAD"
echo ""

SECOND_RESPONSE=$(mktemp)
SECOND_HTTP_CODE=$(curl -s -o "$SECOND_RESPONSE" -w "%{http_code}" \
  -X POST "http://localhost:$DEMO_PORT/api/v1/sub-wallets" \
  -H 'Authorization: Bearer demo-admin-token' \
  -H 'Content-Type: application/json' \
  -H "PAYMENT-SIGNATURE: $PAYMENT_PAYLOAD" \
  -d "$SUB_WALLET_PAYLOAD")

echo "  Response status: $SECOND_HTTP_CODE"
echo ""

if [ "$SECOND_HTTP_CODE" = "200" ] || [ "$SECOND_HTTP_CODE" = "201" ]; then
  echo "  $SECOND_HTTP_CODE OK — Payment accepted, sub-wallet created!"
  echo ""
  echo "  Response body:"
  cat "$SECOND_RESPONSE" | python3 -m json.tool 2>/dev/null || cat "$SECOND_RESPONSE"
  echo ""

  # Show PAYMENT-RESPONSE header
  echo "  PAYMENT-RESPONSE header:"
  curl -s -D - \
    -X POST "http://localhost:$DEMO_PORT/api/v1/sub-wallets" \
    -H 'Authorization: Bearer demo-admin-token' \
    -H 'Content-Type: application/json' \
    -H "PAYMENT-SIGNATURE: $PAYMENT_PAYLOAD" \
    -d "$SUB_WALLET_PAYLOAD" 2>/dev/null \
    | grep -i "^PAYMENT-RESPONSE:" | head -1
  echo ""

  echo "============================================"
  echo "  DEMO SUCCESSFUL"
  echo "============================================"
  echo ""
  echo "The x402 micropayment flow works end-to-end:"
  echo "  1. Request without payment  → 402 Payment Required"
  echo "  2. Request with PAYMENT-SIGNATURE → 200 OK"
  echo ""
  echo "To try with REAL on-chain payments:"
  echo "  1. Set CHAIN_RPC_URL, CHAIN_SIGNER_PRIVATE_KEY, etc."
  echo "  2. Remove X402_DEMO_MODE or set it to false"
  echo "  3. Ensure the facilitator has ETH for gas"
  echo "  4. Ensure the payer has USDC (or the configured token)"
  echo ""
  rm -f "$FIRST_RESPONSE" "$SECOND_RESPONSE"
  exit 0
else
  echo "  Unexpected status. Response body:"
  cat "$SECOND_RESPONSE"
  echo ""
  rm -f "$FIRST_RESPONSE" "$SECOND_RESPONSE"
  exit 1
fi
