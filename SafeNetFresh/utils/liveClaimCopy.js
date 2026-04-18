/**
 * Strips legacy "daily limit" prefix from claim messages and returns text for highlighted display.
 */
export function stripDailyLimitPrefix(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/^Daily payout limit reached \(1\/day\)\.\s*/i, '')
    .replace(/^Daily payout already credited[^\n]*\n?/i, '')
    .trim();
}
