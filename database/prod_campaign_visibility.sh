#!/usr/bin/env bash
# Show, hide or unhide a single campaign on Explore.
#
# Visibility is meta.publicHidden on public.campaigns, read by
# loadPublicHiddenCampaignKeys in frontend/api/campaigns.js. Nothing in the
# application writes it; until prod_fix_solana_hidden_flag.sql runs, the only
# writer is a trigger that sets it and never clears it.
#
# Usage:
#   database/prod_campaign_visibility.sh status                  # every chain-101 campaign
#   database/prod_campaign_visibility.sh status <campaign>       # one campaign
#   database/prod_campaign_visibility.sh show   <campaign>       # make it visible
#   database/prod_campaign_visibility.sh hide   <campaign>       # hide it again
#
# `show` removes the key rather than setting it false, so the row looks like one
# that was never touched. It also leaves is_active alone: a campaign the trigger
# marked inactive stays inactive unless you say otherwise, because is_active
# means "still bonding", not "visible".
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${DATABASE_URL:-$(grep -m1 -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"'"'"'"')}"
[ -n "$DB" ] || { echo "DATABASE_URL is not set and .env has none" >&2; exit 1; }

action="${1:-status}"
campaign="${2:-}"

case "$action" in
  status)
    if [ -n "$campaign" ]; then
      psql "$DB" -v ON_ERROR_STOP=1 -x -c "
        select campaign_address, token_address, name, symbol, is_active,
               coalesce(meta->>'publicHidden','(unset)') as public_hidden
          from public.campaigns
         where campaign_address = '$campaign';"
    else
      psql "$DB" -v ON_ERROR_STOP=1 -c "
        select name, symbol, is_active,
               coalesce(meta->>'publicHidden','(unset)') as public_hidden,
               created_at::date as created
          from public.campaigns
         where chain_id = 101
         order by created_at desc
         limit 40;"
    fi
    ;;

  show)
    [ -n "$campaign" ] || { echo "usage: $0 show <campaignAddress>" >&2; exit 1; }
    psql "$DB" -v ON_ERROR_STOP=1 -c "
      update public.campaigns
         set meta = coalesce(meta, '{}'::jsonb) - 'publicHidden'
       where campaign_address = '$campaign'
      returning campaign_address, name, symbol, is_active,
                coalesce(meta->>'publicHidden','(cleared)') as public_hidden;"
    echo
    echo "Visible on Explore now. If it still does not appear, check is_active:"
    echo "  a campaign the trigger marked inactive shows under 'ended', not 'live'."
    ;;

  hide)
    [ -n "$campaign" ] || { echo "usage: $0 hide <campaignAddress>" >&2; exit 1; }
    psql "$DB" -v ON_ERROR_STOP=1 -c "
      update public.campaigns
         set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('publicHidden', true)
       where campaign_address = '$campaign'
      returning campaign_address, name, symbol, is_active,
                meta->>'publicHidden' as public_hidden;"
    ;;

  *)
    echo "usage: $0 {status|show|hide} [campaignAddress]" >&2
    exit 1
    ;;
esac
