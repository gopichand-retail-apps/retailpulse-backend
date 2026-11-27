const HOUR_MS = 60 * 60 * 1000;

export const PROFILES = Object.freeze(['empty', 'demo']);

export const SOURCE_STATES = Object.freeze({
  awaitingFirstSale: 'awaiting_first_sale',
  emptyPeriod: 'empty_period',
  current: 'current',
  stale: 'stale',
  missing: 'missing',
});

export function parseProfile(value) {
  if (value === undefined || value === '') return undefined;
  if (PROFILES.includes(value)) return value;
  throw new Error('RETAILPULSE_PROFILE must be "empty" or "demo".');
}

/**
 * A database keeps the profile it was created with. Demo fixtures are never mixed into an empty
 * install, and a database that already holds sales but predates profiles is treated as demo data.
 */
export function resolveProfile({ requested, stored, hasSales }) {
  const existing = PROFILES.includes(stored) ? stored : hasSales ? 'demo' : undefined;
  if (existing === undefined) return requested ?? 'empty';
  if (requested !== undefined && requested !== existing) {
    throw new Error(`The requested profile "${requested}" conflicts with the database profile "${existing}".`);
  }
  return existing;
}

export function establishProfile(database, requested) {
  try {
    const stored = database.prepare("SELECT value FROM app_settings WHERE key = 'profile'").get()?.value;
    const hasSales = database.prepare('SELECT 1 AS found FROM sales_facts LIMIT 1').get() !== undefined;
    const profile = resolveProfile({ requested, stored, hasSales });
    database
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES ('profile', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(profile);
    return profile;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function connectionForProfile(profile) {
  return profile === 'demo' ? 'fixture' : 'none';
}

function isStale({ cutoffAt, now, staleAfterHours }) {
  return cutoffAt !== null && now.getTime() - Date.parse(cutoffAt) > staleAfterHours * HOUR_MS;
}

export function deriveSourceState({ connection, totalSales, scopeSales, cutoffAt, now, staleAfterHours }) {
  if (totalSales === 0) return SOURCE_STATES.awaitingFirstSale;
  if (connection === 'none') return SOURCE_STATES.missing;
  if (isStale({ cutoffAt, now, staleAfterHours })) return SOURCE_STATES.stale;
  return scopeSales === 0 ? SOURCE_STATES.emptyPeriod : SOURCE_STATES.current;
}

export function buildSource({ profile, activity, days, now, staleAfterHours }) {
  const connection = connectionForProfile(profile);
  return {
    profile,
    connection,
    state: deriveSourceState({
      connection,
      totalSales: activity.totalSales,
      scopeSales: activity.scopeSales,
      cutoffAt: activity.lastSaleAt,
      now,
      staleAfterHours,
    }),
    cutoffAt: activity.lastSaleAt,
    coverage: { daysWithSales: activity.daysWithSales, daysInPeriod: days },
  };
}
