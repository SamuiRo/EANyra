/** Posting cadence parsing, dependency-free (used by validation and the content plan). */

/**
 * Parse a human posting cadence: "daily", "weekly", "2 posts per week",
 * "3/week", "every 2 days", "monthly", "щодня", "3 рази на тиждень", "5/тиждень".
 * @returns {{ text: string, per_week: number, interval_days: number } | null}
 */
export function parseFrequency(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const s = text.toLowerCase();
  const perWeek = n => (n > 0 && n <= 100 ? { text, per_week: n, interval_days: Math.round(7 / n * 100) / 100 } : null);
  if (/^(daily|every ?day|щодня|щоденно|кожен день|кожного дня)$/.test(s)) return perWeek(7);
  if (/^(weekly|every ?week|щотижня|щотижнево|раз на тиждень)$/.test(s)) return perWeek(1);
  if (/^(biweekly|every (2|two) weeks|раз на два тижні)$/.test(s)) return perWeek(0.5);
  if (/^(monthly|every ?month|щомісяця|раз на місяць)$/.test(s)) return perWeek(7 / 30);
  let match = s.match(/every\s+(\d+(?:\.\d+)?)\s*days?|кожні\s+(\d+)\s*(?:дні|днів|день)/);
  if (match) return perWeek(7 / Number(match[1] ?? match[2]));
  const number = '(\\d+(?:[.,]\\d+)?)';
  match = s.match(new RegExp(`${number}\\s*(?:x|×|posts?|пост(?:и|ів)?|раз(?:и|ів)?)?\\s*(?:/|per|a|в|на)\\s*(day|день|week|wk|тиждень|month|місяць)`));
  if (match) {
    const n = Number(match[1].replace(',', '.'));
    const unit = match[2];
    if (['day', 'день'].includes(unit)) return perWeek(n * 7);
    if (['month', 'місяць'].includes(unit)) return perWeek(n * 7 / 30);
    return perWeek(n);
  }
  return null;
}
