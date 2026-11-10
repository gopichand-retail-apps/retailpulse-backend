import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalyticsRepository } from './analytics.repository.mjs';
import { aggregateSales, createRange, mapMetric } from './analytics.metrics.mjs';
import { seedSales } from './analytics.seed.mjs';
import { loadModel } from './server.mjs';

function createTestRepository(t, model = loadModel()) {
  const repository = createAnalyticsRepository({ databasePath: ':memory:', model });
  t.after(() => repository.close());
  return repository;
}

const allStores = { days: 30, storeId: null, category: null };

test('seeded sales produce consistent dashboard metrics and daily series', (t) => {
  const repository = createTestRepository(t);
  const dashboard = repository.getDashboard(allStores);

  assert.ok(dashboard.metrics.revenueCents > 0);
  assert.ok(dashboard.metrics.transactions > 0);
  assert.ok(dashboard.metrics.unitsSold > dashboard.metrics.transactions);
  assert.equal(dashboard.series.length, 30);
  assert.equal(dashboard.stores.length, 4);
  assert.equal(dashboard.products.length, 6);
  assert.equal(dashboard.categories.length, 4);
  assert.ok(dashboard.metrics.grossMarginCents < dashboard.metrics.revenueCents);
});

test('store filter limits the store comparison to the requested store', (t) => {
  const repository = createTestRepository(t);
  const dashboard = repository.getDashboard({ ...allStores, storeId: 'store-harbor' });

  assert.equal(dashboard.stores.length, 1);
  assert.equal(dashboard.stores[0].id, 'store-harbor');
  assert.ok(dashboard.stores[0].revenueCents > 0);
});

test('alert edits persist enabled state and threshold', (t) => {
  const repository = createTestRepository(t);
  const updated = repository.updateAlert('alert-revenue-drop', { threshold: -18, enabled: false });
  const alert = repository.getAlerts(allStores).find((item) => item.id === 'alert-revenue-drop');

  assert.equal(updated, true);
  assert.equal(alert.threshold, -18);
  assert.equal(alert.enabled, false);
  assert.equal(repository.getActivity(1)[0].eventName, 'alert.updated');
  assert.equal(repository.updateAlert('missing-alert', { threshold: 1, enabled: true }), false);
});

test('replayed ingestion keys do not insert duplicate sales records', (t) => {
  const repository = createTestRepository(t);
  const before = repository.getDashboard(allStores).metrics.revenueCents;
  const first = repository.ingestSales('retailpulse-test-batch');
  const after = repository.getDashboard(allStores).metrics.revenueCents;
  const replay = repository.ingestSales('retailpulse-test-batch');

  assert.equal(first.replayed, false);
  assert.ok(first.recordsAdded > 0);
  assert.ok(after > before);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recordsAdded, first.recordsAdded);
  assert.equal(repository.getDashboard(allStores).metrics.revenueCents, after);
});

test('product lists support name and stock sorting', (t) => {
  const repository = createTestRepository(t);
  const ranges = {
    current: { start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), end: new Date().toISOString() },
    previous: {
      start: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  const names = repository.getProducts(allStores, ranges, 'name');
  const stock = repository.getProducts(allStores, ranges, 'stock');

  assert.ok(names[0].name.localeCompare(names[1].name) < 0);
  assert.ok(stock[0].stockOnHand <= stock[1].stockOnHand);
  for (const product of stock) {
    assert.equal(typeof product.transactionsChangePct, 'number');
    assert.equal(typeof product.unitsChangePct, 'number');
    assert.equal(typeof product.averageBasketChangePct, 'number');
  }
});

test('creates UTC date ranges with exclusive end boundaries', () => {
  const range = createRange(7, '2026-11-01T13:45:00.000Z');

  assert.equal(range.start, '2026-10-26T00:00:00.000Z');
  assert.equal(range.end, '2026-11-02T00:00:00.000Z');
});

test('handles empty date ranges and unknown product/store identifiers', (t) => {
  const repository = createTestRepository(t);
  const current = createRange(7, '2099-01-10T12:00:00.000Z');
  const previous = createRange(7, new Date(new Date(current.start).getTime() - 1));
  const ranges = { current, previous };
  const products = repository.getProducts(allStores, ranges, 'units');
  const stores = repository.getStorePerformance(allStores, ranges);

  assert.ok(products.length > 0);
  assert.equal(
    products.every((product) => product.revenueCents === 0),
    true,
  );
  assert.equal(
    products.every((product) => product.revenueChangePct === 0),
    true,
  );
  assert.equal(stores.length, 4);
  assert.equal(
    stores.every((store) => store.averageBasketCents === 0),
    true,
  );
  assert.deepEqual(repository.getProductBreakdown('missing-product', allStores, current), []);
  assert.equal(repository.getStore('missing-store'), null);
  assert.equal(repository.getProduct('missing-product'), null);
});

test('returns filtered store and product breakdowns', (t) => {
  const repository = createTestRepository(t);
  const current = createRange(30, new Date());
  const product = loadModel().seed.products[0];
  const breakdown = repository.getProductBreakdown(product.id, { ...allStores, category: product.category }, current);
  const filtered = repository.getProductBreakdown(product.id, { ...allStores, storeId: 'store-harbor' }, current);

  assert.ok(breakdown.length > 0);
  assert.ok(breakdown.every((row) => row.revenueCents > 0));
  assert.ok(filtered.every((row) => row.storeId === 'store-harbor'));
  assert.ok(
    repository
      .getProducts(
        { ...allStores, category: product.category },
        {
          current,
          previous: createRange(30, new Date(new Date(current.start).getTime() - 1)),
        },
      )
      .every((item) => item.category === product.category),
  );
});

test('evaluates every alert comparison operator and safely defaults unknown metrics', (t) => {
  const model = loadModel();
  model.seed.alerts = [
    { ...model.seed.alerts[0], id: 'lt', metricKey: 'revenueCents', operator: '<', threshold: 1e15 },
    { ...model.seed.alerts[0], id: 'lte', metricKey: 'revenueCents', operator: '<=', threshold: 1e15 },
    { ...model.seed.alerts[0], id: 'gt', metricKey: 'revenueCents', operator: '>', threshold: -1 },
    { ...model.seed.alerts[0], id: 'gte', metricKey: 'revenueCents', operator: '>=', threshold: 0 },
    { ...model.seed.alerts[0], id: 'unknown', metricKey: 'missingMetric', operator: '?', threshold: 1 },
  ];
  const repository = createTestRepository(t, model);
  const alerts = repository.getAlerts(allStores);

  assert.equal(alerts.find((alert) => alert.id === 'lt').triggered, true);
  assert.equal(alerts.find((alert) => alert.id === 'lte').triggered, true);
  assert.equal(alerts.find((alert) => alert.id === 'gt').triggered, true);
  assert.equal(alerts.find((alert) => alert.id === 'gte').triggered, true);
  assert.equal(alerts.find((alert) => alert.id === 'unknown').value, 0);
  assert.equal(alerts.find((alert) => alert.id === 'unknown').triggered, false);
  assert.equal(
    alerts.every((alert) => typeof alert.enabled === 'boolean'),
    true,
  );
});

test('rolls back a failed sales batch so its idempotency key can be retried', (t) => {
  const model = loadModel();
  const repository = createTestRepository(t, model);
  const originalProductId = model.seed.patterns[0].productId;
  model.seed.patterns[0].productId = 'missing-product';

  assert.throws(() => repository.ingestSales('rollback-test-batch'), /unknown product/);
  assert.equal(repository.getActivity(20).length, 0);

  model.seed.patterns[0].productId = originalProductId;
  const retry = repository.ingestSales('rollback-test-batch');
  assert.equal(retry.replayed, false);
  assert.ok(retry.recordsAdded > 0);
  assert.equal(repository.getActivity(20)[0].eventName, 'sales.ingested');
});

test('maps zero metrics and sorts unsupported product modes by revenue', (t) => {
  const model = loadModel();
  model.seed.salesDays = 0;
  const repository = createTestRepository(t, model);
  const current = createRange(7, new Date());
  const ranges = {
    current,
    previous: createRange(7, new Date(new Date(current.start).getTime() - 1)),
  };
  const byRevenue = repository.getProducts(allStores, ranges, 'revenue');
  const fallback = repository.getProducts(allStores, ranges, 'unsupported');
  const dashboard = repository.getDashboard({ ...allStores, days: 7 });

  assert.deepEqual(fallback, byRevenue);
  assert.equal(dashboard.metrics.revenueCents, 0);
  assert.equal(dashboard.metrics.grossMarginPct, 0);
  assert.equal(
    dashboard.series.every((day) => day.revenueCents === 0),
    true,
  );
  assert.deepEqual(dashboard.categories, []);
  assert.deepEqual(aggregateSales([]), mapMetric());
});

test('rejects seed patterns that reference unavailable products', () => {
  const database = {
    prepare: () => ({
      run: () => {
        throw new Error('Unexpected seed insert.');
      },
    }),
  };
  const model = {
    seed: {
      products: [],
      salesDays: 1,
      patterns: [{ productId: 'missing-product' }],
    },
  };

  assert.throws(() => seedSales(database, model, new Date('2026-11-01T00:00:00.000Z')), /unknown product/);
});
