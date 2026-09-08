from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {path}, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "frontend/api/leagueRouter.js",
    '''    await client.query(
      `insert into public.league_epoch_payouts
        (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
       values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8)
       on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
      [
        row.chainId,
        row.period,
        row.epochStart,
        row.category,
        row.rank,
        row.recipientAddress,
        row.amountRaw,
        verification.txHash,
      ],
    );
''',
    '''    const { rows: payoutRows } = await client.query(
      `insert into public.league_epoch_payouts
        (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
       values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8)
       on conflict (chain_id, period, epoch_start, category, rank)
       do update set
         recipient_address = excluded.recipient_address,
         amount_raw = excluded.amount_raw,
         tx_hash = excluded.tx_hash,
         paid_at = now()
       where public.league_epoch_payouts.tx_hash is null
       returning tx_hash as "txHash"`,
      [
        row.chainId,
        row.period,
        row.epochStart,
        row.category,
        row.rank,
        row.recipientAddress,
        row.amountRaw,
        verification.txHash,
      ],
    );
    if (!payoutRows[0]?.txHash) {
      const error = new Error("League payout slot was recorded concurrently and cannot be overwritten");
      error.code = "LEAGUE_PAYOUT_ALREADY_RECORDED";
      throw error;
    }
''',
)

replace_once(
    "frontend/api/leaguePayouts.js",
    '''    const txHash = body.txHash ? String(body.txHash).toLowerCase().trim() : null;
    const payouts = Array.isArray(body.payouts) ? body.payouts : [];

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
''',
    '''    const txHash = body.txHash ? String(body.txHash).toLowerCase().trim() : null;
    const payouts = Array.isArray(body.payouts) ? body.payouts : [];

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (txHash && !/^0x[a-f0-9]{64}$/.test(txHash)) return json(res, 400, { error: "Invalid txHash" });
''',
)

replace_once(
    "frontend/api/leaguePayouts.js",
    '''      const r = await pool.query(
        `insert into public.league_epoch_payouts
           (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
         values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
         on conflict (chain_id, period, epoch_start, category, rank) do nothing`,
        [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash]
      );
''',
    '''      const r = await pool.query(
        `insert into public.league_epoch_payouts
           (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
         values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
         on conflict (chain_id, period, epoch_start, category, rank)
         do update set
           recipient_address = excluded.recipient_address,
           amount_raw = excluded.amount_raw,
           tx_hash = excluded.tx_hash,
           paid_at = now()
         where public.league_epoch_payouts.tx_hash is null
           and excluded.tx_hash is not null`,
        [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash]
      );
''',
)

p = Path("frontend/scripts/agent6-all-claims-three-chain.test.mjs")
text = p.read_text(encoding="utf-8")
anchor = '''assert.match(router, /pg_advisory_xact_lock/);\n'''
addition = '''assert.match(router, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(router, /LEAGUE_PAYOUT_ALREADY_RECORDED/);\n\nconst leaguePayouts = read("api/leaguePayouts.js");\nassert.match(leaguePayouts, /Invalid txHash/);\nassert.match(leaguePayouts, /where public\\.league_epoch_payouts\\.tx_hash is null/);\nassert.match(leaguePayouts, /excluded\\.tx_hash is not null/);\n'''
if anchor not in text:
    raise SystemExit("test insertion anchor not found")
p.write_text(text.replace(anchor, anchor + addition, 1), encoding="utf-8")
