-- Hide indexer placeholder Solana campaigns (name/symbol Solana Launch / SOL).
-- Run on the INDEXER/showcase DB that production Home reads.
-- Does not delete rows. Sets is_active=false so they drop off the live feed.

begin;

update public.campaigns
   set is_active = false,
       name = concat('hidden-', left(campaign_address, 6)),
       symbol = left(campaign_address, 4),
       updated_at = now()
 where chain_id = 101
   and name = 'Solana Launch'
   and symbol = 'SOL';

commit;
