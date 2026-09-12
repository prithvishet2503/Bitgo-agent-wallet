import type { Role } from './common.js';

/**
 * Named-permission RBAC, mirroring BitGo's user-management-service pattern: a
 * `PermissionEntity` is a data-driven string key (`wallet_create`, etc.) that
 * roles are composed of, rather than business logic checking `role === 'admin'`
 * directly. UMS backs this with Role/Permission/RoleUser join tables in Postgres;
 * this prototype keeps the same shape (a permission key + a role->permissions
 * lookup) without the full join-table/Resource-scoping machinery, since there is
 * only one role per user rather than per-enterprise role grants.
 */
export const PERMISSIONS = {
  ENTERPRISE_CREATE: 'enterprise_create',
  WALLET_CREATE: 'wallet_create',
  WALLET_SUSPEND: 'wallet_suspend',
  POLICY_MANAGE: 'policy_manage',
  AUTONOMY_MODE_CHANGE: 'autonomy_mode_change',
  APPROVAL_DECIDE: 'approval_decide',
  QUARANTINE_RELEASE: 'quarantine_release',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL_PERMISSIONS,
  compliance: [
    PERMISSIONS.WALLET_SUSPEND,
    PERMISSIONS.POLICY_MANAGE,
    PERMISSIONS.AUTONOMY_MODE_CHANGE,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.QUARANTINE_RELEASE,
  ],
  developer: [PERMISSIONS.WALLET_CREATE],
  viewer: [],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role];
}
