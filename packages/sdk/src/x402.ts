/**
 * x402 Payment Protocol — Client (Buyer) Support
 *
 * Enables the SDK to automatically handle HTTP 402 Payment Required responses
 * by signing and retrying with payment authorization. The user provides an EVM
 * signer; the SDK then pays for protected API calls transparently.
 *
 * PRD mapping: Section 6.7 Developer Tooling. The x402 client capability
 * lets AI agents using this SDK pay per API call — the flagship integration
 * from PRD Section 8.
 */

import type { PaymentRequired, PaymentPayload } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function base64Encode(data: string): string {
  if (typeof globalThis !== 'undefined' && typeof globalThis.btoa === 'function') {
    const bytes = new TextEncoder().encode(data);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return globalThis.btoa(binary);
  }
  return Buffer.from(data, 'utf8').toString('base64');
}

function base64Decode(data: string): string {
  if (typeof globalThis !== 'undefined' && typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(data, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// x402 signer wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a viem-compatible signer into the ClientEvmSigner interface.
 * The signer must have `address` and `signTypedData`.
 */
export function toClientEvmSigner(signer: {
  address: `0x${string}`;
  signTypedData: (params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
}): ClientEvmSigner {
  return {
    address: signer.address,
    signTypedData: (msg) => signer.signTypedData(msg),
  };
}

// ---------------------------------------------------------------------------
// 402 handler
// ---------------------------------------------------------------------------

/**
 * Decodes a PAYMENT-REQUIRED header value (base64 JSON) into a
 * PaymentRequired object.
 */
export function decodePaymentRequired(headerValue: string): PaymentRequired {
  return JSON.parse(base64Decode(headerValue)) as PaymentRequired;
}

/**
 * Encodes a PaymentPayload into a PAYMENT-SIGNATURE header value
 * (base64 JSON).
 */
export function encodePaymentSignature(payload: PaymentPayload): string {
  return base64Encode(JSON.stringify(payload));
}

/**
 * Handles an HTTP 402 response by creating a payment payload and returning
 * the PAYMENT-SIGNATURE headers to retry with.
 *
 * @param paymentRequiredHeader - The PAYMENT-REQUIRED header value (base64)
 * @param signer - The EVM signer to authorize payment
 * @returns Headers to add to the retried request, or null if payment cannot
 *   be made (no supported scheme)
 */
export async function createPaymentHeaders(
  paymentRequiredHeader: string,
  signer: ClientEvmSigner,
): Promise<Record<string, string> | null> {
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequired(paymentRequiredHeader);
  } catch {
    return null;
  }

  // Find a supported payment option (EVM exact scheme).
  const evmAccepts = paymentRequired.accepts.filter(
    a => a.scheme === 'exact' && a.network.startsWith('eip155:'),
  );
  if (evmAccepts.length === 0) {
    return null;
  }

  // Pick the first EVM exact option.
  const selected = evmAccepts[0];

  // Use the EVM exact client scheme to create the payment payload.
  const scheme = new ExactEvmScheme(signer);
  const result = await scheme.createPaymentPayload(
    paymentRequired.x402Version ?? 2,
    selected,
    { extensions: paymentRequired.extensions },
  );

  const payload: PaymentPayload = {
    x402Version: result.x402Version,
    resource: paymentRequired.resource,
    accepted: selected,
    payload: result.payload,
    extensions: result.extensions,
  };

  return { 'PAYMENT-SIGNATURE': encodePaymentSignature(payload) };
}

export type { ClientEvmSigner } from '@x402/evm';
