/**
 * Outbox producer. Callers should prefer enqueueNotification() with chainId.
 * emitNotification() remains for existing jobs; it routes through the V1
 * contract so Robinhood cannot be labelled BNB.
 */

import { enqueueNotification } from "./notificationContract.js";

export { enqueueNotification } from "./notificationContract.js";

/**
 * @param {Object} db
 * @param {Object} params
 * @param {string} params.eventType
 * @param {string} [params.chain]
 * @param {number|string} [params.chainId]
 * @param {string} params.dedupKey
 * @param {Object} params.payload
 * @param {string} [params.markerKey]
 * @param {string} [params.entityType]
 * @param {string} [params.entityId]
 */
export async function emitNotification(db, params) {
  try {
    return await enqueueNotification(db, {
      eventType: params.eventType,
      chain: params.chain,
      chainId: params.chainId ?? params.payload?.chainId ?? params.payload?.chain_id,
      environment: params.environment,
      entityType: params.entityType,
      entityId: params.entityId,
      dedupKey: params.dedupKey,
      payload: params.payload,
      markerKey: params.markerKey,
      occurredAt: params.occurredAt,
    });
  } catch (err) {
    console.error("[api/lib/notifications] emitNotification error:", err);
    throw err;
  }
}
