// Park-local time helpers. Everything the user sees is in Anaheim time.

export const TZ = 'America/Los_Angeles';

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "2 pm", "2:30 pm", "11:05 am". */
export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = timeFmt.formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const h = get('hour');
  const m = get('minute');
  const ap = get('dayPeriod').toLowerCase();
  return m === '00' ? `${h} ${ap}` : `${h}:${m} ${ap}`;
}

/** YYYY-MM-DD for the park's calendar day containing ms. */
export function todayKey(ms = Date.now()) {
  return dateFmt.format(new Date(ms)); // en-CA gives ISO order
}

/** "just now", "2 min", "1 h 5 min" for an age in ms. */
export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const minutes = (ms) => Math.round(ms / 60e3);

/**
 * The park day for "done today" and "is this snapshot from today": the calendar day 4 hours ago,
 * so a park open until 1 am doesn't reset done marks at midnight.
 */
export function parkDayKey(ms = Date.now()) {
  return todayKey(ms - 4 * 3600e3);
}

const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const offFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Minutes the park's clock is ahead of UTC at instant ms (negative in Anaheim). */
function parkOffsetMin(ms) {
  const p = Object.fromEntries(offFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60e3);
}

/** "HH:MM" on park day "YYYY-MM-DD", in park time, as epoch ms. */
export function parkTime(dayKey, hhmm) {
  const guess = Date.parse(`${dayKey}T${hhmm}:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  const first = guess - parkOffsetMin(guess) * 60e3;
  return guess - parkOffsetMin(first) * 60e3; // second pass settles DST edges
}

/** "HH:MM" (24 h) in park time, for <input type="time">. */
export const hhmm = (ms) => hmFmt.format(new Date(ms));

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
/** "Sat, Sep 26" for a "YYYY-MM-DD" key. */
export const fmtDay = (dayKey) => dayFmt.format(new Date(`${dayKey}T12:00:00Z`));

/** Park-local hour 0–23 at instant ms. */
export const parkHour = (ms) => Number(hmFmt.format(new Date(ms)).slice(0, 2));

/** Day of week 0 (Sun) – 6 (Sat) for a "YYYY-MM-DD" key. */
export const weekdayOf = (dayKey) => new Date(`${dayKey}T12:00:00Z`).getUTCDay();
