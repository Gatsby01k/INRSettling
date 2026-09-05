/**
 * Reading and changing the workspace security policy — decision D-007.
 *
 * The decision itself is pure and lives in `@inrsettle/domain`. This is the
 * application-layer orchestration: read current state, ask the domain, then
 * write the change, its audit record and its event in one transaction.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import {
  planSeparationOfDutiesChange, resolveSeparationOfDuties,
  type Capability, type PrincipalRef, type TenantScope,
} from '@inrsettle/domain'
import { eventSink } from './events.js'

export async function getSeparationOfDuties(tx: Db, scope: TenantScope): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: schema.workspaceSecurityPolicies.separationOfDutiesEnabled })
    .from(schema.workspaceSecurityPolicies)
    .where(and(
      eq(schema.workspaceSecurityPolicies.workspaceId, scope.workspaceId),
      eq(schema.workspaceSecurityPolicies.environment, scope.environment),
    ))
    .limit(1)
  return resolveSeparationOfDuties(row?.enabled, scope.environment)
}

export interface SetSeparationOfDutiesInput {
  enabled: boolean
  actor: PrincipalRef
  actorCapabilities: ReadonlySet<Capability>
  reason?: string
  confirmLiveDowngrade?: boolean
}

export async function setSeparationOfDuties(
  tx: Db, scope: TenantScope, input: SetSeparationOfDutiesInput,
): Promise<{ enabled: boolean }> {
  const current = await getSeparationOfDuties(tx, scope)

  const plan = planSeparationOfDutiesChange({
    environment: scope.environment,
    current,
    requested: input.enabled,
    actor: input.actor,
    actorCapabilities: input.actorCapabilities,
    reason: input.reason,
    confirmLiveDowngrade: input.confirmLiveDowngrade,
  })

  await tx
    .insert(schema.workspaceSecurityPolicies)
    .values({
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      separationOfDutiesEnabled: plan.to,
      updatedByType: input.actor.type,
      updatedById: input.actor.id,
    })
    .onConflictDoUpdate({
      target: [
        schema.workspaceSecurityPolicies.workspaceId,
        schema.workspaceSecurityPolicies.environment,
      ],
      set: {
        separationOfDutiesEnabled: plan.to,
        updatedAt: new Date(),
        updatedByType: input.actor.type,
        updatedById: input.actor.id,
      },
    })

  const sink = eventSink(tx)
  await sink.audit(scope, {
    actor: input.actor,
    action: plan.auditAction,
    subjectType: 'workspace',
    subjectId: scope.workspaceId,
    before: { separationOfDutiesEnabled: plan.from },
    after: { separationOfDutiesEnabled: plan.to },
    ...(plan.reason ? { reason: plan.reason } : {}),
  })
  await sink.event(scope, {
    type: plan.eventType,
    subjectType: 'workspace',
    subjectId: scope.workspaceId,
    actor: input.actor,
    payload: { policy: 'separation_of_duties', from: plan.from, to: plan.to },
  })

  return { enabled: plan.to }
}
