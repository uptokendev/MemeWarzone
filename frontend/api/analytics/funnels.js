import { pool } from "../../server/db.js";

const FUNNELS = [
  {
    id: "connect_to_create",
    label: "Connect wallet → create token",
    steps: [
      { name: "wallet_connect_succeeded", label: "Wallet connected" },
      { name: "token_create_succeeded", label: "Token created" },
    ],
  },
  {
    id: "connect_to_buy",
    label: "Connect wallet → buy",
    steps: [
      { name: "wallet_connect_succeeded", label: "Wallet connected" },
      { name: "buy_submitted", label: "Buy submitted" },
    ],
  },
  {
    id: "token_to_buy",
    label: "Token page → buy",
    steps: [
      { name: "token_page_viewed", label: "Token page viewed" },
      { name: "buy_submitted", label: "Buy submitted" },
    ],
  },
  {
    id: "recruiter_to_connect",
    label: "Recruiter invite → wallet connect",
    steps: [
      { name: "recruiter_link_landed", label: "Landed on invite" },
      { name: "wallet_connect_succeeded", label: "Wallet connected" },
    ],
  },
  {
    id: "cta_to_draft",
    label: "Home create CTA → draft saved",
    steps: [
      { name: "page_cta_clicked", label: "Clicked create CTA" },
      { name: "draft_created_succeeded", label: "Draft saved" },
    ],
  },
];

async function distinctEventUsers(from, to, app, name) {
  const params = [from, to, name];
  let appClause = "";
  if (app === "public" || app === "admin") {
    params.push(app);
    appClause = `and app = $${params.length}`;
  }
  const result = await pool.query(
    `select count(distinct anonymous_id)::int as n
       from public.analytics_events
      where ts >= $1 and ts < $2
        and name = $3
        ${appClause}`,
    params,
  );
  return result.rows[0]?.n || 0;
}

async function orderedFollowUsers(from, to, app, firstName, secondName) {
  const params = [from, to, firstName, secondName];
  let firstApp = "";
  let followApp = "";
  if (app === "public" || app === "admin") {
    params.push(app);
    firstApp = `and first_event.app = $${params.length}`;
    followApp = `and follow_event.app = $${params.length}`;
  }

  const result = await pool.query(
    `select count(distinct follow_event.anonymous_id)::int as n
       from public.analytics_events follow_event
       join (
         select first_event.anonymous_id, min(first_event.ts) as t
           from public.analytics_events first_event
          where first_event.ts >= $1 and first_event.ts < $2
            and first_event.name = $3
            ${firstApp}
          group by first_event.anonymous_id
       ) first_seen
         on first_seen.anonymous_id = follow_event.anonymous_id
      where follow_event.ts >= first_seen.t
        and follow_event.ts < $2
        and follow_event.name = $4
        ${followApp}`,
    params,
  );
  return result.rows[0]?.n || 0;
}

export async function analyticsFunnels({ from, to, app }) {
  const funnels = [];
  for (const funnel of FUNNELS) {
    const first = await distinctEventUsers(from, to, app, funnel.steps[0].name);
    const second = await orderedFollowUsers(from, to, app, funnel.steps[0].name, funnel.steps[1].name);
    funnels.push({
      id: funnel.id,
      label: funnel.label,
      steps: [
        {
          name: funnel.steps[0].name,
          label: funnel.steps[0].label,
          count: first,
          conversionFromPrevious: null,
        },
        {
          name: funnel.steps[1].name,
          label: funnel.steps[1].label,
          count: second,
          conversionFromPrevious: first ? second / first : null,
        },
      ],
    });
  }

  return { from, to, app, funnels };
}

export default analyticsFunnels;
