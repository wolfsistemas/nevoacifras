import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '';
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:contato@nevoacifras.app';
const PUSH_SECRET = Deno.env.get('PUSH_SHARED_SECRET') || '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

function sbHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (PUSH_SECRET && req.headers.get('x-push-secret') !== PUSH_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !SERVICE_KEY) {
    return json({ error: 'not configured' }, 500);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const msg = payload?.record ?? payload;
  const shareToken = msg?.share_token;
  if (!shareToken) return json({ skipped: true });

  const sender = msg?.user_id ?? null;
  const username = String(msg?.username || 'Equipe').slice(0, 40);
  const body = String(msg?.body || 'Novo recado na lista').slice(0, 140);

  const qs = new URLSearchParams({
    select: 'id,user_id,endpoint,p256dh,auth',
    share_token: `eq.${shareToken}`,
  });
  const listRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?${qs}`, {
    headers: sbHeaders(),
  });
  if (!listRes.ok) {
    return json({ error: 'query failed', status: listRes.status }, 500);
  }
  const subs = await listRes.json();
  const targets = (Array.isArray(subs) ? subs : []).filter((s) => s.user_id !== sender);

  const notification = JSON.stringify({
    title: username,
    body,
    url: `./#/share/${shareToken}`,
    tag: `chat-${shareToken}`,
  });

  let sent = 0;
  let removed = 0;
  await Promise.all(
    targets.map(async (s: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notification,
        );
        sent++;
      } catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${s.id}`, {
            method: 'DELETE',
            headers: sbHeaders(),
          }).catch(() => {});
          removed++;
        }
      }
    }),
  );

  return json({ sent, removed, total: targets.length });
});
