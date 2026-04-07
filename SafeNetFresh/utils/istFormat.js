/**
 * India Standard Time (Asia/Kolkata) formatting — keeps Home, Claims, and payouts consistent.
 */

const IST_OPTS = { timeZone: 'Asia/Kolkata' };

/**
 * Backend stores claim/simulation times in UTC. Python often serializes without `Z`, and
 * `new Date("2025-04-07T23:08:38")` is interpreted as *local* time in JS — wrong vs Home
 * (which uses server-side IST). Treat timezone-less ISO datetimes as UTC.
 */
function parseServerTimestamp(isoOrDate) {
  if (isoOrDate instanceof Date) return isoOrDate;
  const s = String(isoOrDate ?? '').trim();
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T12:00:00.000Z`);
  }
  const isoLike = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
  if (!isoLike) {
    return new Date(s);
  }
  const normalized = s.includes('T') ? s.replace(' ', 'T') : s.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const hasTz =
    /Z$/i.test(normalized) ||
    /[+-]\d{2}:\d{2}$/.test(normalized) ||
    /[+-]\d{2}\d{2}$/.test(normalized);
  if (hasTz) return new Date(normalized);
  return new Date(`${normalized}Z`);
}

export function formatIstDateTime(isoOrDate) {
  if (isoOrDate == null || isoOrDate === '') return '—';
  try {
    const d = parseServerTimestamp(isoOrDate);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      ...IST_OPTS,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}

/** Payout list: prefer full timestamp; fall back to date-only strings without inventing a wrong time. */
export function formatPayoutWhen(row) {
  if (!row || typeof row !== 'object') return '—';
  const raw = row.created_at || row.timestamp || row.credited_at;
  if (raw) return formatIstDateTime(raw);
  const only = row.date;
  if (only == null || only === '') return '—';
  if (typeof only === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(only.trim())) {
    const [y, m, d] = only.trim().split('-').map(Number);
    const noonIst = new Date(
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+05:30`
    );
    if (!Number.isNaN(noonIst.getTime())) {
      return noonIst.toLocaleDateString('en-IN', {
        ...IST_OPTS,
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
  }
  try {
    const d = only instanceof Date ? only : parseServerTimestamp(only);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-IN', { ...IST_OPTS, day: 'numeric', month: 'short', year: 'numeric' });
    }
  } catch {
    /* fall through */
  }
  if (typeof only === 'string') return only;
  return '—';
}

function istYmdParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...IST_OPTS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !d) return null;
  return { y: Number(y), m: Number(m), d: Number(d) };
}

function addCalendarDays(y, m, d, add) {
  const t = Date.UTC(y, m - 1, d + add);
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 14-day outlook chips: deterministic mock, calendar anchored to IST “today”. */
export function buildOutlook14Ist(zoneId) {
  const z = String(zoneId || 'hyd_central');
  const seed = Array.from(z).reduce((a, c) => a + c.charCodeAt(0), 0);
  const start = istYmdParts(new Date());
  if (!start) return [];
  const days = [];
  for (let i = 0; i < 14; i++) {
    const { y, m, d } = addCalendarDays(start.y, start.m, start.d, i);
    const noonIst = new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+05:30`);
    const dow = new Intl.DateTimeFormat('en-IN', { ...IST_OPTS, weekday: 'short' }).format(noonIst);
    const r = (seed + i * 31) % 100;
    let icon = '⛅';
    let tag = 'Clear';
    let tone = '#64748b';
    if (r > 78) {
      icon = '☔';
      tag = 'Wet';
      tone = '#1d4ed8';
    } else if (r > 55) {
      icon = '🌤️';
      tag = 'Mixed';
      tone = '#ca8a04';
    } else if (r < 18) {
      icon = '🌡️';
      tag = 'Hot';
      tone = '#dc2626';
    }
    days.push({
      key: i,
      dow,
      dayNum: d,
      icon,
      tag,
      tone,
    });
  }
  return days;
}

export function formatIstTodayLong(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      ...IST_OPTS,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(now);
  } catch {
    return '';
  }
}
