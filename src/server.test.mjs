import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer, createCsv, loadModel } from './server.mjs';

async function startTestServer(t, options = {}) {
  const api = createApiServer({ databasePath: ':memory:', ...options });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(() => api.close());
  const address = api.server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('health reports the application and its local SQLite storage', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/health`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.application, 'RetailPulse');
  assert.equal(result.data.storage, 'sqlite');
  assert.ok(response.headers.get('x-request-id'));
});

test('version reports the backend package release', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/version`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.data, { service: 'retailpulse-api', version: '1.0.0' });
});

test('stores are seeded from the public content model', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/stores`);
  const result = await response.json();
  const model = loadModel();

  assert.equal(response.status, 200);
  assert.equal(result.data.length, model.seed.stores.length);
  assert.equal(result.data[0].id, model.seed.stores[0].id);
});

test('CSV export escapes formula-like text without altering numeric fields', () => {
  const model = {
    reports: {
      csvHeaders: ['Record type', 'Name', 'Category', 'SKU', 'Revenue', 'Transactions', 'Units', 'Gross margin'],
      recordTypes: { store: 'Store', product: 'Product' },
    },
    filters: {
      categories: [{ id: 'synthetic-category', label: '\uFEFF+1+1' }],
    },
  };
  const csv = createCsv(
    model,
    [
      {
        name: '  \t=HYPERLINK("https://example.invalid","Open")',
        revenueCents: 1234,
        transactions: 2,
        unitsSold: 3,
        grossMarginCents: -450,
      },
    ],
    [
      {
        name: '\u0001@SUM(1,1)',
        category: 'synthetic-category',
        sku: 'SKU, "synthetic"',
        revenueCents: -1234,
        transactions: 4,
        unitsSold: 5,
        grossMarginCents: 550,
      },
    ],
  );

  assert.equal(
    csv,
    [
      '"Record type","Name","Category","SKU","Revenue","Transactions","Units","Gross margin"',
      `"Store","'  \t=HYPERLINK(""https://example.invalid"",""Open"")","","","12.34","2","3","-4.50"`,
      `"Product","'\u0001@SUM(1,1)","'\uFEFF+1+1","SKU, ""synthetic""","-12.34","4","5","5.50"`,
    ].join('\r\n'),
  );
});

test('requests from other browser origins are rejected', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/stores`, {
    headers: { Origin: 'https://unapproved.example' },
  });
  const result = await response.json();

  assert.equal(response.status, 403);
  assert.equal(result.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('browser preflights allow alert saves and idempotent sales ingestion', async (t) => {
  const baseUrl = await startTestServer(t);
  const origins = loadModel().app.allowedOrigins;

  for (const origin of origins) {
    for (const method of ['PATCH', 'POST']) {
      const response = await fetch(`${baseUrl}/api/v1/alerts/alert-revenue-drop`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type,idempotency-key',
        },
      });
      const allowedMethods = response.headers.get('access-control-allow-methods') ?? '';
      const allowedHeaders = response.headers.get('access-control-allow-headers') ?? '';

      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.ok(allowedMethods.split(/,\s*/).includes(method));
      assert.match(allowedHeaders, /content-type/i);
      assert.match(allowedHeaders, /idempotency-key/i);
    }
  }
});

test('both local UI hostnames can read the dashboard', async (t) => {
  const baseUrl = await startTestServer(t);
  for (const origin of loadModel().app.allowedOrigins) {
    const response = await fetch(`${baseUrl}/api/v1/dashboard?days=30`, {
      headers: { Origin: origin },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
});

test('local database parent directories are created when needed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'retailpulse-storage-'));
  const databasePath = join(directory, 'nested', 'retailpulse.sqlite');
  const api = createApiServer({ databasePath });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(async () => {
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${api.server.address().port}/api/v1/health`);

  assert.equal(response.status, 200);
  assert.equal(existsSync(databasePath), true);
});

test('unknown paths use the shared error envelope', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/unknown`);
  const result = await response.json();

  assert.equal(response.status, 404);
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.equal(result.error.requestId, response.headers.get('x-request-id'));
});

test('validates report filters and serves store and product details', async (t) => {
  const baseUrl = await startTestServer(t);
  const model = loadModel();
  const days = model.filters.ranges[0].days;
  const storeId = model.seed.stores[0].id;
  const product = model.seed.products[0];

  const invalidRange = await fetch(`${baseUrl}/api/v1/dashboard?days=1`);
  assert.equal(invalidRange.status, 400);
  assert.equal((await invalidRange.json()).error.code, 'INVALID_RANGE');

  const missingStoreFilter = await fetch(`${baseUrl}/api/v1/dashboard?storeId=missing-store`);
  assert.equal(missingStoreFilter.status, 404);
  assert.equal((await missingStoreFilter.json()).error.code, 'STORE_NOT_FOUND');

  const invalidCategory = await fetch(`${baseUrl}/api/v1/dashboard?category=missing-category`);
  assert.equal(invalidCategory.status, 400);
  assert.equal((await invalidCategory.json()).error.code, 'INVALID_CATEGORY');

  const dashboard = await fetch(`${baseUrl}/api/v1/dashboard?days=${days}`);
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).data.period.days, days);

  const store = await fetch(`${baseUrl}/api/v1/stores/${encodeURIComponent(storeId)}?days=${days}`);
  const storeResult = await store.json();
  assert.equal(store.status, 200);
  assert.equal(storeResult.data.id, storeId);
  assert.ok(Array.isArray(storeResult.data.series));

  const missingStore = await fetch(`${baseUrl}/api/v1/stores/missing-store`);
  assert.equal(missingStore.status, 404);
  assert.equal((await missingStore.json()).error.code, 'STORE_NOT_FOUND');

  const invalidSort = await fetch(`${baseUrl}/api/v1/products?sort=unknown`);
  assert.equal(invalidSort.status, 400);
  assert.equal((await invalidSort.json()).error.code, 'INVALID_SORT');

  const products = await fetch(`${baseUrl}/api/v1/products?search=${encodeURIComponent(product.sku)}&sort=name`);
  const productResults = await products.json();
  assert.equal(products.status, 200);
  assert.equal(productResults.data.length, 1);
  assert.equal(productResults.data[0].id, product.id);

  const productDetail = await fetch(`${baseUrl}/api/v1/products/${encodeURIComponent(product.id)}?days=${days}`);
  assert.equal(productDetail.status, 200);
  assert.equal((await productDetail.json()).data.id, product.id);

  const missingProduct = await fetch(`${baseUrl}/api/v1/products/missing-product`);
  assert.equal(missingProduct.status, 404);
  assert.equal((await missingProduct.json()).error.code, 'PRODUCT_NOT_FOUND');
});

test('validates and persists alert updates and handles malformed request bodies', async (t) => {
  const baseUrl = await startTestServer(t);
  const model = loadModel();
  const alertId = model.seed.alerts[0].id;
  const threshold = Math.min(
    model.validation.maximumAlertThreshold,
    Math.max(model.validation.minimumAlertThreshold, 0),
  );

  const alerts = await fetch(`${baseUrl}/api/v1/alerts`);
  assert.equal(alerts.status, 200);
  assert.ok((await alerts.json()).data.length > 0);

  const updated = await fetch(`${baseUrl}/api/v1/alerts/${alertId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threshold, enabled: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.threshold, threshold);

  for (const body of [
    'null',
    JSON.stringify({
      threshold: model.validation.maximumAlertThreshold + 1,
      enabled: true,
    }),
    '{',
  ]) {
    const response = await fetch(`${baseUrl}/api/v1/alerts/${alertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 400);
  }

  const missingAlert = await fetch(`${baseUrl}/api/v1/alerts/missing-alert`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threshold, enabled: true }),
  });
  assert.equal(missingAlert.status, 404);
  assert.equal((await missingAlert.json()).error.code, 'ALERT_NOT_FOUND');
});

test('requires idempotency keys and serves activity and CSV reports', async (t) => {
  const baseUrl = await startTestServer(t);

  const missingKey = await fetch(`${baseUrl}/api/v1/sales/ingest`, {
    method: 'POST',
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const invalidKey = await fetch(`${baseUrl}/api/v1/sales/ingest`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'not allowed!' },
  });
  assert.equal(invalidKey.status, 400);

  const firstIngest = await fetch(`${baseUrl}/api/v1/sales/ingest`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'retailpulse-test-batch' },
  });
  assert.equal(firstIngest.status, 201);
  assert.equal((await firstIngest.json()).data.replayed, false);

  const replay = await fetch(`${baseUrl}/api/v1/sales/ingest`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'retailpulse-test-batch' },
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.replayed, true);

  const activity = await fetch(`${baseUrl}/api/v1/activity`);
  assert.equal(activity.status, 200);
  assert.ok((await activity.json()).data.some((event) => event.eventName === 'sales.ingested'));

  const report = await fetch(`${baseUrl}/api/v1/reports/export`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/csv/);
  assert.match(report.headers.get('content-disposition'), /retailpulse-performance-report\.csv/);
  assert.match(await report.text(), /"Record type","Name"/);
});

test('bounds request bodies and returns safe errors for malformed paths', async (t) => {
  const model = loadModel();
  const baseUrl = await startTestServer(t);
  const largeBody = JSON.stringify('x'.repeat(model.validation.maximumRequestBytes + 1));
  const oversized = await fetch(`${baseUrl}/api/v1/alerts/${model.seed.alerts[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: largeBody,
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');

  const malformedPath = await fetch(`${baseUrl}/api/v1/stores/%`);
  const result = await malformedPath.json();
  assert.equal(malformedPath.status, 500);
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.equal(result.error.message, model.copy.errors.server);
  assert.ok(result.error.requestId);
});

test('uses valid trace context and security response headers', async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/health`, {
    headers: {
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-trace-id'), '0123456789abcdef0123456789abcdef');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const generatedTrace = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { traceparent: 'invalid' },
  });
  assert.match(generatedTrace.headers.get('x-trace-id'), /^[\da-f]{32}$/i);
});

test('validates a configured E2E origin before opening the database', async (t) => {
  const envName = 'RETAILPULSE_E2E_FRONTEND_ORIGIN';
  const previousOrigin = process.env[envName];
  t.after(() => {
    if (previousOrigin === undefined) delete process.env[envName];
    else process.env[envName] = previousOrigin;
  });

  process.env[envName] = 'http://localhost:5801';
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Origin: 'http://localhost:5801' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5801');

  for (const invalidOrigin of [
    'not-an-origin',
    'https://localhost:5801',
    'http://example.com',
    'http://localhost:5801/path',
  ]) {
    process.env[envName] = invalidOrigin;
    assert.throws(() => createApiServer({ databasePath: ':memory:' }), /HTTP loopback origin/);
  }
});
