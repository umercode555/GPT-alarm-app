const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = (n) => String(n).padStart(2, '0');

export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "3 October 2026, 10:05 PM"
export function formatStamp(d) {
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h}:${pad(d.getMinutes())} ${ap}`;
}

export function formatDateLong(d) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "22:30" -> "10:30 PM"
export function fmtHHMM(s) {
  const [h, m] = (s || '00:00').split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${pad(m)} ${ap}`;
}

export function timeOnly(d) {
  return fmtHHMM(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

export function buildMessage(habit, decision, when) {
  const stamp = formatStamp(when);
  const activity = (habit.activity || '').trim() || `doing ${habit.name}`;
  if (decision === 'going') return `I'm ${activity} now — ${stamp}.`;
  if (decision === 'not_going') return `I'm not ${activity} today — ${stamp}.`;
  const n = habit.snooze_minutes || 15;
  return `I'm snoozing ${habit.name} for ${n} minutes — ${stamp}.`;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
.
