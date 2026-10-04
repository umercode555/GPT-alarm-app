// Supabase REST helpers (no external libraries). Auth = email/password, tokens auto-refresh.
export const DEFAULTS = { pollSeconds: 60, quiet: false, closeTab: false, notify: true, paused: false };
const KEYS = ['url', 'key', 'email', 'password', 'session', 'pollSeconds', 'quiet', 'closeTab', 'notify', 'paused'];

export async function getCfg() {
  const v = await chrome.storage.local.get(KEYS);
  return { ...DEFAULTS, ...v };
}
export const setCfg = (o) => chrome.storage.local.set(o);

async function authCall(cfg, grant, body) {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Auth failed (${r.status})`);
  const session = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  await setCfg({ session });
  return session;
}

async function getToken(cfg, force = false) {
  let s = cfg.session;
  if (!force && s && s.exp - Date.now() > 60000) return s.access;
  if (s?.refresh) {
    try { return (await authCall(cfg, 'refresh_token', { refresh_token: s.refresh })).access; } catch { /* fall through to password */ }
  }
  return (await authCall(cfg, 'password', { email: cfg.email, password: cfg.password })).access;
}

export async function login(cfg) {
  return authCall(cfg, 'password', { email: cfg.email, password: cfg.password });
}

export async function rest(path, { method = 'GET', body, prefer } = {}) {
  let cfg = await getCfg();
  if (!cfg.url || !cfg.key || !cfg.email) throw new Error('Not set up yet — open Settings.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(cfg, attempt > 0);
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: cfg.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) { cfg = await getCfg(); continue; }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(json?.message || `Supabase error ${res.status}`);
    return json;
  }
}

// Atomically claims ONE deliverable message (pending & due, or a 'sending' claim older than 10 min).
export async function claimNext() {
  const rows = await rest('rpc/claim_next_message', { method: 'POST', body: {} });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function markSent(id) {
  const rows = await rest(`decisions?id=eq.${id}&status=eq.sending`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { status: 'sent', sent_at: new Date().toISOString(), last_error: null },
  });
  return rows?.length > 0;
}

export async function release(msg, error) {
  const mins = Math.min(30, Math.pow(2, Math.max(0, (msg.attempts || 1) - 1)));
  await rest(`decisions?id=eq.${msg.id}&status=eq.sending`, {
    method: 'PATCH',
    body: { status: 'pending', claimed_at: null, last_error: String(error).slice(0, 300), next_attempt_at: new Date(Date.now() + mins * 60000).toISOString() },
  });
}

export const listPending = () =>
  rest('decisions?status=in.(pending,sending)&select=id,habit_name,message,status,attempts,last_error,decided_at,next_attempt_at&order=decided_at.asc&limit=50');
export const listRecent = () =>
  rest('decisions?status=eq.sent&select=id,habit_name,message,sent_at&order=sent_at.desc&limit=5');

// "Check now" = also skip any waiting back-off so failed messages are retried immediately.
export const resetBackoff = () =>
  rest('decisions?status=eq.pending&next_attempt_at=not.is.null', { method: 'PATCH', body: { next_attempt_at: null } });
