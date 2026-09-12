import { z } from 'zod';

/** Roles a user can hold within an Organization. Maps to PRD personas (Section 3).
 * What each role can actually DO is looked up via `hasPermission` (see
 * permissions.ts) rather than sprinkling `role === 'admin'` checks everywhere -
 * mirroring BitGo's named-permission RBAC model (user-management-service) instead
 * of a hardcoded role enum baked into business logic. */
export const RoleSchema = z.enum(['admin', 'compliance', 'developer', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

/** Standard chain scope for v1 (Section 5.1): EVM-only, EIP-7702-supporting chains. */
export const SupportedChainSchema = z.enum(['ethereum-mainnet', 'base', 'optimism', 'arbitrum']);
export type SupportedChain = z.infer<typeof SupportedChainSchema>;

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
  }
}

export const nowIso = (): string => new Date().toISOString();
