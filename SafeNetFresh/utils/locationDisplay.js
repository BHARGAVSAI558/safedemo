/**
 * Shorten long reverse-geocode strings (e.g. Nominatim / device) for UI headers.
 * Keeps the first few meaningful segments and drops pin codes + very generic regions.
 */
export function formatShortLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 2) return s;

  const skip = new Set([
    'india',
    'andhra pradesh',
    'telangana',
    'karnataka',
    'tamil nadu',
    'maharashtra',
    'ntr',
    'urban',
  ]);

  const take = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (/^\d{5,7}$/.test(low)) continue;
    if (low.length <= 2) continue;
    if (skip.has(low)) continue;
    take.push(p);
    if (take.length >= 3) break;
  }

  if (take.length) return take.join(' · ');
  return parts.slice(0, 2).join(' · ');
}
