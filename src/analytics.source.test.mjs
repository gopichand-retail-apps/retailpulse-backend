import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_STATES,
  buildSource,
  connectionForProfile,
  deriveSourceState,
  parseProfile,
  resolveProfile,
} from './analytics.source.mjs';

const HOUR_MS = 60 * 60 * 1000;
const now = new Date('2026-11-24T12:00:00.000Z');
const hoursBefore = (hours) => new Date(now.getTime() - hours * HOUR_MS).toISOString();
const staleAfterHours = 36;

function derive(overrides) {
  return deriveSourceState({
    connection: 'fixture',
    totalSales: 10,
    scopeSales: 5,
    cutoffAt: hoursBefore(2),
    now,
    staleAfterHours,
    ...overrides,
  });
}

test('parses the profile setting and rejects unknown values', () => {
  assert.equal(parseProfile(undefined), undefined);
  assert.equal(parseProfile(''), undefined);
  assert.equal(parseProfile('empty'), 'empty');
  assert.equal(parseProfile('demo'), 'demo');
  for (const invalid of ['Demo', 'production', ' empty', 'true']) {
    assert.throws(() => parseProfile(invalid), /RETAILPULSE_PROFILE must be "empty" or "demo"/);
  }
});

test('resolves the install profile from the request, the stored profile and existing sales', () => {
  const cases = [
    { requested: undefined, stored: 'demo', hasSales: true, expected: 'demo' },
    { requested: 'demo', stored: 'demo', hasSales: true, expected: 'demo' },
    { requested: undefined, stored: 'empty', hasSales: false, expected: 'empty' },
    { requested: undefined, stored: undefined, hasSales: true, expected: 'demo' },
    { requested: 'demo', stored: undefined, hasSales: true, expected: 'demo' },
    { requested: undefined, stored: undefined, hasSales: false, expected: 'empty' },
    { requested: 'demo', stored: undefined, hasSales: false, expected: 'demo' },
    { requested: 'empty', stored: undefined, hasSales: false, expected: 'empty' },
    { requested: undefined, stored: 'unrecognised', hasSales: false, expected: 'empty' },
    { requested: undefined, stored: 'unrecognised', hasSales: true, expected: 'demo' },
  ];
  for (const { expected, ...input } of cases) {
    assert.equal(resolveProfile(input), expected, JSON.stringify(input));
  }
});

test('refuses to mix demo fixtures with an empty install, in either direction', () => {
  const conflicts = [
    { requested: 'empty', stored: 'demo', hasSales: true },
    { requested: 'demo', stored: 'empty', hasSales: false },
    { requested: 'empty', stored: undefined, hasSales: true },
  ];
  for (const input of conflicts) {
    assert.throws(() => resolveProfile(input), /conflicts with the database profile/, JSON.stringify(input));
  }
});

test('maps each profile to what actually feeds sales', () => {
  assert.equal(connectionForProfile('demo'), 'fixture');
  assert.equal(connectionForProfile('empty'), 'none');
});

test('awaiting the first sale wins whether or not a source is connected', () => {
  assert.equal(derive({ totalSales: 0, scopeSales: 0, cutoffAt: null }), SOURCE_STATES.awaitingFirstSale);
  assert.equal(
    derive({ connection: 'none', totalSales: 0, scopeSales: 0, cutoffAt: null }),
    SOURCE_STATES.awaitingFirstSale,
  );
});

test('committed sales without a connected source are reported as a missing source', () => {
  assert.equal(derive({ connection: 'none' }), SOURCE_STATES.missing);
  assert.equal(derive({ connection: 'none', cutoffAt: hoursBefore(500) }), SOURCE_STATES.missing);
});

test('a source is stale only once its cutoff is strictly older than the freshness window', () => {
  assert.equal(derive({ cutoffAt: hoursBefore(staleAfterHours) }), SOURCE_STATES.current);
  assert.equal(derive({ cutoffAt: hoursBefore(staleAfterHours + 0.001) }), SOURCE_STATES.stale);
  assert.equal(derive({ cutoffAt: hoursBefore(200) }), SOURCE_STATES.stale);
});

test('a connected source with no sales in scope shows an accurate zero, unless it is stale', () => {
  assert.equal(derive({ scopeSales: 0 }), SOURCE_STATES.emptyPeriod);
  assert.equal(derive({ scopeSales: 0, cutoffAt: hoursBefore(200) }), SOURCE_STATES.stale);
  assert.equal(derive({ scopeSales: 3 }), SOURCE_STATES.current);
});

test('sales that are all dated after now do not make the source stale', () => {
  assert.equal(derive({ cutoffAt: null }), SOURCE_STATES.current);
  assert.equal(derive({ cutoffAt: null, scopeSales: 0 }), SOURCE_STATES.emptyPeriod);
});

test('builds the public source summary with its cutoff and coverage', () => {
  const source = buildSource({
    profile: 'demo',
    activity: { totalSales: 9, scopeSales: 4, lastSaleAt: hoursBefore(5), daysWithSales: 28 },
    days: 30,
    now,
    staleAfterHours,
  });

  assert.deepEqual(source, {
    profile: 'demo',
    connection: 'fixture',
    state: 'current',
    cutoffAt: hoursBefore(5),
    coverage: { daysWithSales: 28, daysInPeriod: 30 },
  });
});

test('builds an empty-install summary with no cutoff and no covered days', () => {
  const source = buildSource({
    profile: 'empty',
    activity: { totalSales: 0, scopeSales: 0, lastSaleAt: null, daysWithSales: 0 },
    days: 7,
    now,
    staleAfterHours,
  });

  assert.deepEqual(source, {
    profile: 'empty',
    connection: 'none',
    state: 'awaiting_first_sale',
    cutoffAt: null,
    coverage: { daysWithSales: 0, daysInPeriod: 7 },
  });
});
