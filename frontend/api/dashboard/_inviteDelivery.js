export function dashboardInviteConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  const redirectBase = String(process.env.DASHBOARD_INVITE_REDIRECT_URL || "").trim();

  if (!supabaseUrl || !serviceRole) {
    throw Object.assign(new Error("Supabase Admin invitation is not configured."), {
      code: "DASHBOARD_INVITE_NOT_CONFIGURED",
    });
  }
  if (!redirectBase) {
    throw Object.assign(new Error("DASHBOARD_INVITE_REDIRECT_URL is required."), {
      code: "DASHBOARD_INVITE_REDIRECT_MISSING",
    });
  }

  const redirectUrl = new URL(redirectBase);
  redirectUrl.pathname = "/set-password";
  redirectUrl.search = "";
  redirectUrl.hash = "";

  return {
    supabaseUrl,
    serviceRole,
    anonKey: anonKey || serviceRole,
    redirectTo: redirectUrl.toString(),
  };
}

async function postAuth(url, key, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function authMessage(payload, status, fallback) {
  return String(
    payload?.msg ||
      payload?.message ||
      payload?.error_description ||
      payload?.error ||
      fallback ||
      `Supabase auth request failed (${status}).`,
  );
}

export function isExistingSupabaseUserError(status, payload) {
  if (![400, 409, 422].includes(Number(status))) return false;
  const message = authMessage(payload, status, "");
  return /(already\s+(been\s+)?registered|already\s+exists|user\s+already|already\s+a\s+user)/i.test(message);
}

export async function sendDashboardAccessEmail(email) {
  const { supabaseUrl, serviceRole, anonKey, redirectTo } = dashboardInviteConfig();

  const inviteUrl = new URL(`${supabaseUrl}/auth/v1/invite`);
  inviteUrl.searchParams.set("redirect_to", redirectTo);
  const invite = await postAuth(inviteUrl, serviceRole, { email });

  if (invite.response.ok) {
    return { mode: "invite", id: invite.payload?.id || null };
  }

  if (!isExistingSupabaseUserError(invite.response.status, invite.payload)) {
    const message = authMessage(invite.payload, invite.response.status);
    throw Object.assign(new Error(message), {
      code: "DASHBOARD_INVITE_DELIVERY_FAILED",
      status: invite.response.status,
    });
  }

  const otpUrl = new URL(`${supabaseUrl}/auth/v1/otp`);
  otpUrl.searchParams.set("redirect_to", redirectTo);
  const magicLink = await postAuth(otpUrl, anonKey, {
    email,
    create_user: false,
  });

  if (!magicLink.response.ok) {
    const message = authMessage(magicLink.payload, magicLink.response.status);
    throw Object.assign(new Error(message), {
      code: "DASHBOARD_INVITE_EXISTING_USER_DELIVERY_FAILED",
      status: magicLink.response.status,
    });
  }

  return { mode: "magic_link", id: null };
}
