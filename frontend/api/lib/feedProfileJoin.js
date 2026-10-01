/** Pick the profile row that actually has a name or avatar (profiles are chain-scoped). */
export const AUTHOR_PROFILE_LATERAL = `
left join lateral (
  select display_name, avatar_url
    from public.user_profiles up
   where lower(up.address) = lower(p.author_address)
   order by
     (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
     (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
     up.updated_at desc nulls last
   limit 1
) up on true
`;

export const REPOSTER_PROFILE_LATERAL = `
left join lateral (
  select display_name, avatar_url
    from public.user_profiles up
   where lower(up.address) = lower(rp.author_address)
   order by
     (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
     (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
     up.updated_at desc nulls last
   limit 1
) rup on true
`;
