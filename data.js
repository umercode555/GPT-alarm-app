import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from './supa';

const K = { habits: 'nudge.habits', decisions: 'nudge.decisions', outbox: 'nudge.outbox', snoozes: 'nudge.snoozes', handled: 'nudge.handled' };

const read = async (k, d) => {
  try { const v = await AsyncStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
};
const write = (k, v) => AsyncStorage.setItem(k, JSON.stringify(v));

export const getCachedHabits = () => read(K.habits, []);
export const getSnoozes = () => read(K.snoozes, {});
export const setSnoozes = (v) => write(K.snoozes, v);
export const getOutbox = () => read(K.outbox, []);

export async function wasHandled(id) {
  const list = await read(K.handled, []);
  if (list.includes(id)) return true;
  await write(K.handled, [id, ...list].slice(0, 60));
  return false;
}

export async function loadHabits() {
  const { data, error } = await db().from('habits').select('*').order('remind_time', { ascending: true });
  if (error) return { habits: await read(K.habits, []), offline: true };
  await write(K.habits, data);
  return { habits: data, offline: false };
}

export async function saveHabit(h) {
  const row = {
    name: h.name, activity: h.activity || null, remind_time: h.remind_time,
    repeat_seconds: h.repeat_seconds, snooze_minutes: h.snooze_minutes,
    chat_url: h.chat_url, enabled: h.enabled,
  };
  const q = h.id ? db().from('habits').update(row).eq('id', h.id) : db().from('habits').insert(row);
  const { error } = await q;
  if (error) throw error;
}

export async function deleteHabit(id) {
  const { error } = await db().from('habits').delete().eq('id', id);
  if (error) throw error;
}

export async function loadDecisions() {
  const { data, error } = await db().from('decisions').select('*').order('decided_at', { ascending: false }).limit(300);
  const outbox = await getOutbox();
  const queued = outbox.map((r) => ({ ...r, status: 'queued' }));
  if (error) {
    const cached = await read(K.decisions, []);
    const ids = new Set(queued.map((q) => q.id));
    return { decisions: [...queued, ...cached.filter((c) => !ids.has(c.id))], offline: true };
  }
  await write(K.decisions, data);
  const ids = new Set(data.map((d) => d.id));
  return { decisions: [...queued.filter((q) => !ids.has(q.id)), ...data], offline: false };
}

// Insert is idempotent (client-generated id + ignoreDuplicates), so retrying can never create a duplicate.
async function insertOne(row) {
  const { error } = await db().from('decisions').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function submitDecision(row) {
  try {
    await insertOne(row);
    return true;
  } catch {
    const box = await getOutbox();
    await write(K.outbox, [...box.filter((r) => r.id !== row.id), row]);
    return false;
  }
}

export async function flushOutbox() {
  const box = await getOutbox();
  const left = [];
  for (const r of box) {
    try { await insertOne(r); } catch { left.push(r); }
  }
  await write(K.outbox, left);
  return left.length;
}

export async function retryNow(id) {
  const { error } = await db().from('decisions').update({ next_attempt_at: null }).eq('id', id).eq('status', 'pending');
  if (error) throw error;
}
