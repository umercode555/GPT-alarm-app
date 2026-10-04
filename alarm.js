import { PermissionsAndroid, Platform } from 'react-native';
import Native from '../modules/nudge-alarm';
import { dayKey } from './time';

export const available = !!Native;

export async function askNotificationPermission() {
  try {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      return r === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch {}
  return true;
}

export const status = () => { try { return JSON.parse(Native.status()); } catch { return {}; } };
export const openSettings = (k) => { try { Native.openSettings(k); } catch {} };
export const getPending = () => { try { return JSON.parse(Native.getPending()); } catch { return []; } };
export const ackPending = (ids) => { try { Native.ackPending(JSON.stringify(ids)); } catch {} };
export const stop = (habitId) => { try { Native.stop(habitId); } catch {} };
export const snooze = (h, atMs) => { try { Native.snooze(h.id, h.name, atMs, h.repeat_seconds || 300, h.snooze_minutes || 15); } catch {} };
export const soundName = () => { try { return Native.getSoundName(); } catch { return ''; } };
export const setSound = (uri, name) => Native.setSound(uri, name);
export const clearSound = () => { try { Native.clearSound(); } catch {} };
export const testAlarm = (delayMs) => { try { Native.testAlarm(delayMs); } catch {} };

/**
 * One native exact alarm per habit per day for the next 7 days.
 * When it fires, the native service keeps ringing + re-ringing every "repeat" seconds until you answer.
 * Today is skipped if you already gave a final answer, or if a snooze is running (native handles it).
 */
export function rescheduleAll(habits, decisions, snoozes) {
  if (!Native) return 0;
  const now = Date.now();
  const todayKey = dayKey(new Date());
  const list = [];
  for (const h of habits) {
    if (!h.enabled || !h.remind_time) continue;
    const [hh, mm] = h.remind_time.split(':').map(Number);
    for (let d = 0; d < 7; d++) {
      const t = new Date();
      t.setDate(t.getDate() + d);
      t.setHours(hh, mm, 0, 0);
      if (t.getTime() <= now + 1500) continue;
      if (d === 0) {
        const done = decisions.some((x) => x.habit_id === h.id && x.decision !== 'snoozed' && dayKey(new Date(x.decided_at)) === todayKey);
        if (done) continue;
        if (snoozes[h.id] && snoozes[h.id] > now) continue;
      }
      list.push({ habitId: h.id, name: h.name, at: t.getTime(), repeatSec: h.repeat_seconds || 300, snoozeMin: h.snooze_minutes || 15 });
    }
  }
  try { Native.setSchedule(JSON.stringify(list)); } catch {}
  return list.length;
}
