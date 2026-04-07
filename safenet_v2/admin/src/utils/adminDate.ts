/** Parse API datetimes: timezone-less ISO strings are UTC (matches backend). */
export function parseServerTimestamp(isoOrDate: string | Date): Date {
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

export function formatIstDateTime(iso: string | null | undefined): string {
  if (iso == null || iso === '') return '—';
  try {
    const d = parseServerTimestamp(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}
