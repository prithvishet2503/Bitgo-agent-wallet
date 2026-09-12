import { randomUUID } from 'node:crypto';
import {
  type CreateEnterpriseInput,
  type Enterprise,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PERMISSIONS,
  hasPermission,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import { enterpriseDao } from '../dal/models/enterprise.dao.js';
import { userDao } from '../dal/models/user.dao.js';
import type { User } from '../store/db.js';
import * as auditService from './auditService.js';

/**
 * An Organization can contain more than one Enterprise (separate business units,
 * fund entities, etc.) - mirrors BitGo's real `EnterpriseEntity` belonging
 * `@ManyToOne` to an `OrganizationEntity`. Creating one here is the second half of
 * "can users create new accounts": an org admin can stand up additional
 * Enterprises without going through the organization bootstrap flow again.
 */
export function createEnterprise(input: CreateEnterpriseInput, actingUser: User): Enterprise {
  if (input.organizationId !== actingUser.organizationId) {
    throw new ForbiddenError('Cannot create an Enterprise outside your own Organization');
  }
  if (!hasPermission(actingUser.role, PERMISSIONS.ENTERPRISE_CREATE)) {
    throw new ForbiddenError('Only admins can create a new Enterprise');
  }

  const enterprise: Enterprise = {
    id: `ent_${randomUUID()}`,
    organizationId: input.organizationId,
    name: input.name,
    status: 'active',
    maxSubWallets: input.maxSubWallets,
    createdAt: nowIso(),
  };
  enterpriseDao.createOrUpdate(enterprise);

  // The creating admin gets access to the enterprise they just stood up.
  if (!actingUser.accessibleEnterpriseIds.includes(enterprise.id)) {
    actingUser.accessibleEnterpriseIds.push(enterprise.id);
    userDao.createOrUpdate(actingUser);
  }

  auditService.record({
    enterpriseId: enterprise.id,
    subWalletId: null,
    eventType: 'ENTERPRISE_CREATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Enterprise "${enterprise.name}" created`,
    metadata: { organizationId: input.organizationId },
  });

  return enterprise;
}

export function getEnterprise(id: string): Enterprise {
  const enterprise = enterpriseDao.get(id);
  if (!enterprise) throw new NotFoundError(`Enterprise ${id} not found`);
  return enterprise;
}

/** Enterprises the acting user is allowed to operate on, within their Organization. */
export function listAccessibleEnterprises(actingUser: User): Enterprise[] {
  return enterpriseDao.list((e) => actingUser.accessibleEnterpriseIds.includes(e.id));
}

export function assertAccessible(enterpriseId: string, actingUser: User): Enterprise {
  const enterprise = getEnterprise(enterpriseId);
  if (!actingUser.accessibleEnterpriseIds.includes(enterpriseId)) {
    throw new ForbiddenError(`You do not have access to enterprise ${enterpriseId}`);
  }
  if (enterprise.status === 'suspended') {
    throw new DomainError(`Enterprise "${enterprise.name}" is suspended`, 'ENTERPRISE_SUSPENDED', 409);
  }
  return enterprise;
}
