import { randomUUID } from 'node:crypto';
import {
  type CreateOrganizationInput,
  type Enterprise,
  type Organization,
  DEFAULT_MAX_SUB_WALLETS_PER_ENTERPRISE,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { organizationDao } from '../dal/models/organization.dao.js';
import { enterpriseDao } from '../dal/models/enterprise.dao.js';
import { userDao } from '../dal/models/user.dao.js';
import * as auditService from './auditService.js';

/**
 * "Sign up my institution" - Organization -> Enterprise -> admin User in one call.
 * BitGo's real user-management-service has no equivalent public endpoint:
 * Organizations/Enterprises are lazily materialized from wallet-platform, which
 * owns identity/KYC (see `EnterpriseService.createEnterpriseAndAddToRoles` /
 * `UserService.createUserFromWpUser`). This prototype has no separate identity
 * source of truth to materialize from, so it exposes the bootstrap directly - the
 * public answer to "can a user create a new account".
 */
export interface BootstrapResult {
  organization: Organization;
  enterprise: Enterprise;
  userId: string;
  apiToken: string;
}

export function bootstrap(input: CreateOrganizationInput): BootstrapResult {
  const organization: Organization = {
    id: `org_${randomUUID()}`,
    name: input.organizationName,
    createdAt: nowIso(),
  };
  organizationDao.createOrUpdate(organization);

  const enterprise: Enterprise = {
    id: `ent_${randomUUID()}`,
    organizationId: organization.id,
    name: input.enterpriseName,
    status: 'active',
    maxSubWallets: DEFAULT_MAX_SUB_WALLETS_PER_ENTERPRISE,
    createdAt: nowIso(),
  };
  enterpriseDao.createOrUpdate(enterprise);

  const userId = `user_${randomUUID()}`;
  const apiToken = `bgw_${randomUUID().replace(/-/g, '')}`;
  const user: User = {
    id: userId,
    organizationId: organization.id,
    enterpriseId: enterprise.id,
    accessibleEnterpriseIds: [enterprise.id],
    name: input.adminName,
    role: 'admin',
    apiToken,
  };
  userDao.createOrUpdate(user);

  auditService.record({
    enterpriseId: enterprise.id,
    subWalletId: null,
    eventType: 'ORGANIZATION_CREATED',
    actorUserId: userId,
    actorType: 'user',
    summary: `Organization "${organization.name}" created`,
    metadata: { organizationId: organization.id },
  });
  auditService.record({
    enterpriseId: enterprise.id,
    subWalletId: null,
    eventType: 'ENTERPRISE_CREATED',
    actorUserId: userId,
    actorType: 'user',
    summary: `Enterprise "${enterprise.name}" created`,
    metadata: { enterpriseId: enterprise.id },
  });

  return { organization, enterprise, userId, apiToken };
}

export function getOrganization(id: string): Organization | undefined {
  return organizationDao.get(id);
}

// Referenced by dal cleanliness checks / future multi-org listing; kept for parity
// with the DAO pattern even though no route needs "list all organizations" yet.
export function listOrganizations(): Organization[] {
  return organizationDao.list();
}
