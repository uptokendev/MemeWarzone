import { Pool, PoolClient } from "pg";
import { buildNotificationEnvelope } from "./notificationContract.js";

export async function emitNotification(
  db: Pool | PoolClient,
  params: {
    eventType: string;
    chain: string;
    chainId?: number | string;
    dedupKey: string;
    payload: any;
    markerKey?: string;
    entityType?: string;
    entityId?: string;
    environment?: string;
  }
): Promise<boolean> {
  try {
    const envelope = buildNotificationEnvelope({
      eventType: params.eventType,
      chain: params.chain,
      chainId: params.chainId ?? params.payload?.chainId ?? params.payload?.chain_id,
      environment: params.environment,
      entityType: params.entityType,
      entityId: params.entityId,
      dedupKey: params.dedupKey,
      payload: params.payload && typeof params.payload === "object" ? params.payload : {},
    });

    if (params.markerKey) {
      const res = await db.query(
        `INSERT INTO public.notification_markers (marker_key)
         VALUES ($1) ON CONFLICT DO NOTHING`,
        [params.markerKey]
      );
      if (res.rowCount === 0) {
        return false;
      }
    }

    await db.query(
      `INSERT INTO public.notification_outbox (event_type, chain, dedup_key, payload)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [envelope.eventType, envelope.chain, envelope.dedupKey, JSON.stringify(envelope)]
    );
    return true;
  } catch (err) {
    console.error("[realtime-indexer/notifications] emitNotification error:", err);
    throw err;
  }
}
