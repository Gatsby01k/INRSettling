/**
 * Event and audit persistence — the application-layer implementation of the
 * domain's `EventSink` port.
 *
 * INV-32: an event is written in the same transaction as the state change that
 * produced it, together with its outbox row. Both take the transaction rather
 * than opening one, so a caller cannot write history outside the transaction it
 * belongs to.
 */
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import { newId } from '@inrsettle/ids'
import type { EventSink, TenantScope } from '@inrsettle/domain'

export function eventSink(tx: Db): EventSink {
  return {
    async event(scope: TenantScope, e) {
      const id = newId('event')
      await tx.insert(schema.events).values({
        id,
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        type: e.type,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        actorType: e.actor.type,
        actorId: e.actor.id,
        payload: e.payload ?? {},
      })
      if (e.deliver) {
        await tx.insert(schema.outbox).values({
          id: newId('outbox'),
          eventId: id,
          workspaceId: scope.workspaceId,
          environment: scope.environment,
        })
      }
    },

    async audit(scope: TenantScope, a) {
      await tx.insert(schema.auditLog).values({
        id: newId('audit'),
        workspaceId: scope.workspaceId,
        environment: scope.environment,
        actorType: a.actor.type,
        actorId: a.actor.id,
        action: a.action,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        before: a.before ?? null,
        after: a.after ?? null,
        reason: a.reason ?? null,
      })
    },
  }
}
