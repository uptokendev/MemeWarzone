/** Shared claim SQL for the FeeEscrow worker and Gate O torture tests. */

export const ACQUIRE_LEASE_SQL = `insert into public.solana_worker_leases (worker_name, owner_id, lease_expires_at, heartbeat_at)
       values ($1, $2, now() + make_interval(secs => $3), now())
       on conflict (worker_name) do update set
         owner_id = excluded.owner_id,
         lease_expires_at = excluded.lease_expires_at,
         heartbeat_at = now(),
         updated_at = now()
       where public.solana_worker_leases.lease_expires_at < now()
          or public.solana_worker_leases.owner_id = excluded.owner_id
       returning owner_id`;

export const CLAIM_INIT_SQL = `update public.solana_fee_escrow_accruals
          set init_attempts = init_attempts + 1,
              last_init_attempt_at = now(),
              next_init_attempt_at = now() + interval '60 seconds',
              updated_at = now()
        where chain_id=$1
          and campaign_address=$2
          and init_status in ('pending','failed')
          and (next_init_attempt_at is null or next_init_attempt_at <= now())
        returning campaign_address, escrow_address, init_attempts`;

export const CLAIM_FLUSH_SQL = `update public.solana_fee_escrow_accruals
            set flush_status='submitted',
                flush_attempts = flush_attempts + 1,
                updated_at=now()
          where chain_id=$1
            and campaign_address=$2
            and init_status='initialized'
            and (
              flush_status in ('idle','queued','failed')
              or (flush_status='submitted' and updated_at < now() - interval '2 minutes')
            )
          returning campaign_address`;
