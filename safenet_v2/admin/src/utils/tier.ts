/** Match worker app + API product codes → Basic | Standard | Pro */
export function formatTierLabel(input: string | null | undefined): string {
  if (input == null || input === '') return '—';
  const raw = String(input).trim();
  const low = raw.toLowerCase();
  if (low.includes('basic')) return 'Basic';
  if (low.includes('standard')) return 'Standard';
  if (low.includes('pro')) return 'Pro';
  if (raw === 'Basic' || raw === 'Standard' || raw === 'Pro') return raw;
  return raw;
}
