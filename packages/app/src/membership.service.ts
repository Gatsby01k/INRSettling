/**
 * Memberships and the roles held within them.
 *
 * The frozen RBAC model grants *sets* of roles — SECURITY.md § 3.2 describes an
 * admin who is also an approver — so roles live in their own table and a
 * principal's capabilities are the union of the roles they hold.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import type { WorkspaceRole } from '@inrsettle/contracts'
import {
  capabilitiesFor, ROLE_CHANGE_REVOCATION_REASON,
  type Capability, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'

export async function rolesFor(
  tx: Db, scope: TenantScope, userId: string,
): Promise<WorkspaceRole[]> {
  const rows = await tx
    .select({ role: schema.membershipRoles.role })
    .from(schema.membershipRoles)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.membershipRoles.membershipId))
    .where(and(
      eq(schema.memberships.workspaceId, scope.workspaceId),
      eq(schema.memberships.environment, scope.environment),
      eq(schema.memberships.userId, userId),
    ))
  return rows.map((r) => r.role)
}

export async function capabilitiesOf(
  tx: Db, scope: TenantScope, userId: string,
): Promise<Set<Capability>> {
  return capabilitiesFor(await rolesFor(tx, scope, userId))
}

export async function createMembership(
  tx: Db,
  scope: TenantScope,
  args: { userId: string; roles: readonly WorkspaceRole[]; actor: PrincipalRef },
): Promise<string> {
  const id = newId('membership')
  await tx.insert(schema.memberships).values({
    id,
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    userId: args.userId,
    createdBy: args.actor.id,
  })
  if (args.roles.length > 0) {
    await tx.insert(schema.membershipRoles).values(
      args.roles.map((role) => ({
        membershipId: id,
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        role,
        grantedBy: args.actor.id,
      })),
    )
  }
  return id
}

/**
 * Replace the roles held in a scope.
 *
 * Changing what someone can do must not wait for their current session to
 * expire, so this revokes their live sessions in the same transaction. A
 * privilege change that leaves an old session usable is a privilege change that
 * has not happened yet.
 */
export async function setRoles(
  tx: Db,
  scope: TenantScope,
  args: { userId: string; roles: readonly WorkspaceRole[]; actor: PrincipalRef; reason?: string },
): Promise<{ revokedSessions: number }> {
  const [membership] = await tx
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(
      eq(schema.memberships.workspaceId, scope.workspaceId),
      eq(schema.memberships.environment, scope.environment),
      eq(schema.memberships.userId, args.userId),
    ))
    .limit(1)
  if (!membership) throw new Error(`no membership for ${args.userId} in this scope`)

  const before = await rolesFor(tx, scope, args.userId)

  await tx.delete(schema.membershipRoles)
    .where(eq(schema.membershipRoles.membershipId, membership.id))
  if (args.roles.length > 0) {
    await tx.insert(schema.membershipRoles).values(
      args.roles.map((role) => ({
        membershipId: membership.id,
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        role,
        grantedBy: args.actor.id,
      })),
    )
  }

  const revoked = await tx.update(schema.sessions)
    .set({ revokedAt: new Date(), revokedReason: ROLE_CHANGE_REVOCATION_REASON })
    .where(and(
      eq(schema.sessions.workspaceId, scope.workspaceId),
      eq(schema.sessions.environment, scope.environment),
      eq(schema.sessions.userId, args.userId),
      isNull(schema.sessions.revokedAt),
    ))
    .returning({ id: schema.sessions.id })

  const sink = eventSink(tx)
  await sink.audit(scope, {
    actor: args.actor,
    action: 'membership.roles_changed',
    subjectType: 'user',
    subjectId: args.userId,
    before: { roles: before },
    after: { roles: [...args.roles] },
    ...(args.reason ? { reason: args.reason } : {}),
  })
  await sink.event(scope, {
    type: 'membership.roles_changed',
    subjectType: 'user',
    subjectId: args.userId,
    actor: args.actor,
    payload: { from: before, to: [...args.roles], sessionsRevoked: revoked.length },
  })

  return { revokedSessions: revoked.length }
}

export async function membershipUserIds(
  tx: Db, scope: TenantScope, roles: readonly WorkspaceRole[],
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .innerJoin(schema.membershipRoles, eq(schema.membershipRoles.membershipId, schema.memberships.id))
    .where(and(
      eq(schema.memberships.workspaceId, scope.workspaceId),
      eq(schema.memberships.environment, scope.environment),
      inArray(schema.membershipRoles.role, [...roles]),
    ))
  return rows.map((r) => r.userId)
}
