/** Trust score tiers: backend uses 0–100 (or 0–1 normalized). */
export function trustBadge(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) {
    return { label: 'Standard', tone: 'neutral', points: null };
  }
  const raw = Number(score);
  const points = raw <= 1 ? raw * 100 : raw;
  const pts = Math.round(points * 100) / 100;
  if (pts >= 80) return { label: '🏆 Premium', tone: 'premium', points: pts };
  if (pts >= 60) return { label: '⭐ Trusted', tone: 'trusted', points: pts };
  return { label: 'Standard', tone: 'neutral', points: pts };
}

export function trustLabelOnly(score) {
  const { label, points } = trustBadge(score);
  if (points == null) return { label, short: 'Standard' };
  const short = label.replace(/^🏆\s*|^⭐\s*/u, '').trim();
  return { label, short: short || 'Standard', points };
}
