import * as L from './lib.js';

let running = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- scheduling ----------
async function ensureAlarm() {
  const { pollSeconds } = await L.getCfg();
  const period = Math.max(0.5, (pollSeconds || 60) / 60);
  const a = await chrome.alarms.get('poll');
  if (!a || Math.abs((a.periodInMinutes || 0) - period) > 0.001) await chrome.alarms.create('poll', { periodInMinutes: period, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); check('installed'); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); check('startup'); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') check('alarm'); });
chrome.storage.onChanged.addListener((c) => { if (c.pollSeconds) ensureAlarm(); });
ensureAlarm();

// ---------- main loop ----------
async function setStatus(o) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...o } });
}

async function updateBadge() {
  try {
    const p = await L.listPending();
    await chrome.action.setBadgeBackgroundColor({ color: '#5B5BD6' });
    await chrome.action.setBadgeText({ text: p.length ? String(p.length) : '' });
    return p;
  } catch { return null; }
}

export async function check(reason) {
  if (running) return;
  running = true;
  try {
    const cfg = await L.getCfg();
    if (!cfg.url || !cfg.email) { await setStatus({ error: 'Not set up yet — open Settings.' }); return; }
    if (cfg.paused) { await setStatus({ lastCheck: Date.now(), error: null }); return; }
    let delivered = 0;
    for (let i = 0; i < 40; i++) {
      const msg = await L.claimNext();
      if (!msg) break;
      const res = await deliver(msg, cfg);
      if (res.ok) {
        await confirmSent(msg);
        delivered++;
        if (cfg.notify) chrome.notifications.create(`sent-${msg.id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: `Nudge → ${msg.habit_name}`, message: msg.message });
      } else {
        await L.release(msg, res.error);
        await setStatus({ lastFail: { at: Date.now(), habit: msg.habit_name, error: res.error } });
      }
      await sleep(1500);
    }
    await setStatus({ lastCheck: Date.now(), error: null, lastReason: reason, delivered: ((await chrome.storage.local.get('status')).status?.delivered || 0) + delivered });
  } catch (e) {
    await setStatus({ lastCheck: Date.now(), error: e.message });
  } finally {
    running = false;
    updateBadge();
  }
}

// If the page send worked but the "mark sent" call failed, remember it locally so we NEVER send it twice.
async function confirmSent(msg) {
  const { sentIds = [] } = await chrome.storage.local.get('sentIds');
  await chrome.storage.local.set({ sentIds: [msg.id, ...sentIds].slice(0, 200) });
  for (let i = 0; i < 6; i++) {
    try { await L.markSent(msg.id); return; } catch { await sleep(2000 * (i + 1)); }
  }
}

// ---------- delivery ----------
async function findTab(url, chatId) {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  return tabs.find((t) => (chatId ? (t.url || '').includes(chatId) : (t.url || '').split('#')[0] === url.split('#')[0]));
}

// Wait until the page has finished loading AND stopped navigating (ChatGPT sometimes redirects/reloads once).
async function waitStable(tabId, ms) {
  const end = Date.now() + ms;
  let lastUrl = null, good = 0;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && t.url === lastUrl) { if (++good >= 2) return; } else good = 0;
    lastUrl = t.url;
    await sleep(900);
  }
  throw new Error('ChatGPT page took too long to load');
}

async function deliver(msg, cfg) {
  const { sentIds = [] } = await chrome.storage.local.get('sentIds');
  if (sentIds.includes(msg.id)) return { ok: true, already: true };

  const url = (msg.chat_url || '').trim();
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url)) return { ok: false, error: 'Invalid ChatGPT URL on this habit' };
  const chatId = (url.match(/\/c\/([0-9a-f-]{20,})/i) || [])[1];
  // Default: bring the tab to the front (most reliable). "Quiet" mode tries a background tab first.
  const focus = !cfg.quiet || (msg.attempts || 1) > 1;

  let tab = await findTab(url, chatId);
  let created = false;
  try {
    if (!tab) { tab = await chrome.tabs.create({ url, active: focus }); created = true; }
    else {
      if (tab.discarded) await chrome.tabs.reload(tab.id);
      if (focus) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
    }
    let last = { ok: false, error: 'Unknown error' };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await waitStable(tab.id, 60000);
        const cur = await chrome.tabs.get(tab.id);
        if (chatId && !(cur.url || '').includes(chatId)) {
          return { ok: false, error: `ChatGPT redirected away (now at ${(cur.url || '').slice(0, 60)}). Logged in? Is the chat link still valid?` };
        }
        const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSend, args: [msg.message] });
        last = inj?.result || { ok: false, error: 'No result from page' };
        if (last.ok) break;
        if (last.reload && attempt < 2) { await chrome.tabs.reload(tab.id); await sleep(2500); continue; }
        break;
      } catch (e) {
        last = { ok: false, error: e.message || String(e) };
        if (/frame|removed|closed|receiving end|no tab|navigat|cannot access|error page/i.test(last.error) && attempt < 2) { await sleep(3000); continue; }
        break;
      }
    }
    if (last.ok && created && cfg.closeTab) { await sleep(8000); chrome.tabs.remove(tab.id).catch(() => {}); }
    return last;
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Runs INSIDE the ChatGPT page. Must be fully self-contained.
async function pageSend(text) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const txt = (el) => norm(el ? (el.innerText ?? el.textContent ?? el.value ?? '') : '');
  const want = norm(text);
  const head = want.slice(0, 24);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const COMPOSERS = ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]', 'form textarea', 'textarea', '[contenteditable="true"]'];
  const findComposer = () => { for (const sel of COMPOSERS) for (const el of document.querySelectorAll(sel)) if (visible(el)) return el; return null; };
  const composerText = () => { const c = findComposer(); return c ? (c.value !== undefined && c.tagName === 'TEXTAREA' ? norm(c.value) : txt(c)) : ''; };
  const userMsgs = () => Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
  const alreadyThere = () => {
    const m = userMsgs();
    if (m.length) return m.some((el) => txt(el).includes(want));
    return norm(document.body.innerText || document.body.textContent).includes(want) && !composerText().includes(head);
  };
  const diag = () => {
    const login = !!document.querySelector('[data-testid="login-button"], [data-testid="welcome-login-button"]');
    return `[url=${location.pathname.slice(0, 40)} title="${(document.title || '').slice(0, 30)}" editable=${document.querySelectorAll('[contenteditable="true"]').length} textareas=${document.querySelectorAll('textarea').length} login=${login} text="${norm(document.body.innerText || '').slice(0, 70)}"]`;
  };

  const composer0 = await until(findComposer, 45000);
  if (!composer0) {
    const login = document.querySelector('[data-testid="login-button"], [data-testid="welcome-login-button"]');
    return { ok: false, reload: !login, error: (login ? 'Not logged in to ChatGPT in this Chrome ' : 'ChatGPT message box not found ') + diag() };
  }
  await sleep(1800); // let the chat history render
  if (alreadyThere()) return { ok: true, already: true };

  const STOP = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
  await until(() => !document.querySelector(STOP), 90000); // wait if ChatGPT is mid-reply

  const box = findComposer() || composer0;
  box.focus();
  if (box.tagName === 'TEXTAREA') {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const sel = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text);
    if (!txt(box).includes(head)) {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    if (!txt(box).includes(head)) {
      box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
    }
  }
  await sleep(600);
  if (!composerText().includes(head)) return { ok: false, error: 'Could not type into the ChatGPT box ' + diag() };

  const BTN = 'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label*="Send" i], form button[type="submit"]';
  const findBtn = () => { for (const b of document.querySelectorAll(BTN)) if (!b.disabled && b.getAttribute('aria-disabled') !== 'true' && visible(b)) return b; return null; };
  const pressEnter = () => { for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); };

  const btn = await until(findBtn, 8000);
  if (btn) btn.click(); else pressEnter();
  let cleared = await until(() => !composerText().includes(head), 6000, 300);
  if (!cleared) { pressEnter(); cleared = await until(() => !composerText().includes(head), 6000, 300); }

  const ok = await until(() => alreadyThere() || (cleared && document.querySelector(STOP)), 30000, 400);
  return ok ? { ok: true } : { ok: false, error: 'Could not confirm that ChatGPT accepted the message ' + diag() };
}

// ---------- messages from popup / options ----------
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  (async () => {
    if (m.type === 'check') { try { await L.resetBackoff(); } catch {} await check('manual'); reply({ ok: true }); }
    else if (m.type === 'login') {
      try { await L.setCfg({ ...m.cfg, session: null }); await L.login(await L.getCfg()); await ensureAlarm(); await L.rest('decisions?select=id&limit=1'); check('saved'); reply({ ok: true }); }
      catch (e) { reply({ ok: false, error: e.message }); }
    } else if (m.type === 'status') {
      const { status = {} } = await chrome.storage.local.get('status');
      const cfg = await L.getCfg();
      let pending = null, recent = null;
      try { [pending, recent] = await Promise.all([L.listPending(), L.listRecent()]); } catch {}
      reply({ status, pending, recent, paused: cfg.paused, configured: !!(cfg.url && cfg.email), running });
    }
  })();
  return true;
});
