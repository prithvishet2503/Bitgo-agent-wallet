import { z } from 'zod';

/** Roles that can act on a master account. Maps to PRD personas (Section 3) and
 * role checks referenced throughout Section 6 ("admin/compliance role"). */
export const RoleSchema = z.enum(['admin', 'compliance', 'developer', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const roleCanManagePolicy = (role: Role): boolean =>
  role === 'admin' || role === 'compliance';

export const roleCanReleaseQuarantine = (role: Role): boolean =>
  role === 'admin' || role === 'compliance';

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
