import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DAY_MS,
  addDays,
  aggregateSales,
  calculateAlertValue,
  createRange,
  formatDay,
  groupBy,
  groupByDay,
  groupedMetric,
  isAlertTriggered,
  mapPerformance,
} from './analytics.metrics.mjs';
import { getProductConditions, getSalesRows } from './analytics.query.mjs';
import { seedSales } from './analytics.seed.mjs';

function executeTransaction(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function createAnalyticsRepository({ databasePath, model }) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      region TEXT NOT NULL,
      format TEXT NOT NULL,
      square_feet INTEGER NOT NULL CHECK (square_feet > 0),
      display_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
      stock_on_hand INTEGER NOT NULL CHECK (stock_on_hand >= 0),
      display_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      unit TEXT NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      display_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_facts (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      store_id TEXT NOT NULL REFERENCES stores(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      happened_at TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      channel TEXT NOT NULL,
      UNIQUE (receipt_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS sales_facts_time_idx ON sales_facts(happened_at);
    CREATE INDEX IF NOT EXISTS sales_facts_store_time_idx ON sales_facts(store_id, happened_at);
    CREATE INDEX IF NOT EXISTS sales_facts_product_time_idx ON sales_facts(product_id, happened_at);
    CREATE TABLE IF NOT EXISTS ingestion_batches (
      idempotency_key TEXT PRIMARY KEY,
      batch_number INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      records_added INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at);
  `);

  const insertStore = database.prepare(`
    INSERT OR IGNORE INTO stores
      (id, name, city, region, format, square_feet, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertProduct = database.prepare(`
    INSERT OR IGNORE INTO products
      (id, sku, name, category, unit_price_cents, unit_cost_cents, stock_on_hand, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlert = database.prepare(`
    INSERT OR IGNORE INTO alert_rules
      (id, title, description, metric_key, operator, threshold, unit, severity, enabled, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  executeTransaction(database, () => {
    for (const store of model.seed.stores) {
      insertStore.run(
        store.id,
        store.name,
        store.city,
        store.region,
        store.format,
        store.squareFeet,
        store.displayOrder,
      );
    }
    for (const product of model.seed.products) {
      insertProduct.run(
        product.id,
        product.sku,
        product.name,
        product.category,
        product.unitPriceCents,
        product.unitCostCents,
        product.stockOnHand,
        product.displayOrder,
      );
    }
    for (const alert of model.seed.alerts) {
      insertAlert.run(
        alert.id,
        alert.title,
        alert.description,
        alert.metricKey,
        alert.operator,
        alert.threshold,
        alert.unit,
        alert.severity,
        Number(alert.enabled),
        alert.displayOrder,
      );
    }
    database
      .prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)')
      .run('seed_version', String(model.seed.version));
    seedSales(database, model, new Date());
  });

  function getMetrics(filters, range) {
    return aggregateSales(getSalesRows(database, filters, range));
  }

  function getGroupedPerformance(key, filters, currentRange, previousRange) {
    const current = groupBy(getSalesRows(database, filters, currentRange), key);
    const previous = groupBy(getSalesRows(database, filters, previousRange), key);
    return { current, previous };
  }

  function getProducts(filters, ranges, sortBy = 'revenue') {
    const products = database
      .prepare(
        `SELECT id, sku, name, category, unit_price_cents AS unitPriceCents,
          unit_cost_cents AS unitCostCents, stock_on_hand AS stockOnHand, display_order AS displayOrder
        FROM products
        ${filters.category ? 'WHERE category = ?' : ''}
        ORDER BY display_order`,
      )
      .all(...(filters.category ? [filters.category] : []));
    const currentGroups = getGroupedPerformance('productId', filters, ranges.current, ranges.previous);
    const previous = currentGroups.previous;
    const current = currentGroups.current;
    const productsWithPerformance = products.map((product) => {
      const performance = groupedMetric(current, product.id);
      const previousPerformance = groupedMetric(previous, product.id);
      return {
        ...product,
        ...mapPerformance(performance, previousPerformance),
      };
    });
    const sorters = {
      revenue: (left, right) => right.revenueCents - left.revenueCents,
      units: (left, right) => right.unitsSold - left.unitsSold,
      name: (left, right) => left.name.localeCompare(right.name),
      stock: (left, right) => left.stockOnHand - right.stockOnHand,
    };
    return productsWithPerformance.sort(sorters[sortBy] ?? sorters.revenue);
  }

  function getStorePerformance(filters, ranges) {
    const stores = database
      .prepare(
        `SELECT id, name, city, region, format, square_feet AS squareFeet
        FROM stores ${filters.storeId ? 'WHERE id = ?' : ''} ORDER BY display_order`,
      )
      .all(...(filters.storeId ? [filters.storeId] : []));
    const groups = getGroupedPerformance('groupId', filters, ranges.current, ranges.previous);
    return stores.map((store) => ({
      ...store,
      ...mapPerformance(groupedMetric(groups.current, store.id), groupedMetric(groups.previous, store.id)),
    }));
  }

  function getSeries(filters, ranges, days) {
    const current = groupByDay(getSalesRows(database, filters, ranges.current));
    const previous = groupByDay(getSalesRows(database, filters, ranges.previous));
    return Array.from({ length: days }, (_, index) => {
      const currentDay = addDays(new Date(ranges.current.start), index);
      const previousDay = addDays(new Date(ranges.previous.start), index);
      return {
        date: formatDay(currentDay),
        revenueCents: current.get(formatDay(currentDay))?.revenueCents ?? 0,
        previousRevenueCents: previous.get(formatDay(previousDay))?.revenueCents ?? 0,
        transactions: current.get(formatDay(currentDay))?.transactions ?? 0,
      };
    });
  }

  function getCategoryPerformance(filters, range) {
    const rows = getSalesRows(database, filters, range);
    const grouped = new Map();
    for (const row of rows) {
      const category = grouped.get(row.category) ?? { revenueCents: 0, unitsSold: 0 };
      category.revenueCents += row.quantity * row.unitPriceCents;
      category.unitsSold += row.quantity;
      grouped.set(row.category, category);
    }
    return [...grouped.entries()].map(([id, metrics]) => ({ id, ...metrics }));
  }

  function getDashboard(filters) {
    const today = new Date();
    const current = createRange(filters.days, today);
    const previous = createRange(filters.days, new Date(new Date(current.start).getTime() - DAY_MS));
    const ranges = { current, previous };
    const metrics = mapPerformance(getMetrics(filters, current), getMetrics(filters, previous));
    return {
      period: { days: filters.days, from: formatDay(new Date(current.start)), to: formatDay(today) },
      metrics,
      series: getSeries(filters, ranges, filters.days),
      stores: getStorePerformance(filters, ranges),
      products: getProducts(filters, ranges).slice(0, 6),
      categories: getCategoryPerformance(filters, current),
    };
  }
  function getProductBreakdown(productId, filters, range) {
    const conditions = getProductConditions(filters, range);
    const rows = database
      .prepare(
        `SELECT s.store_id AS storeId, SUM(s.quantity * s.unit_price_cents) AS revenueCents,
          SUM(s.quantity) AS unitsSold, COUNT(DISTINCT s.receipt_id) AS transactions
        FROM sales_facts s
        JOIN products p ON p.id = s.product_id
        WHERE ${conditions.sql} AND s.product_id = ?
        GROUP BY s.store_id`,
      )
      .all(...conditions.values, productId);
    return rows;
  }

  function getStore(id) {
    return (
      database
        .prepare(
          `SELECT id, name, city, region, format, square_feet AS squareFeet
        FROM stores WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  function getProduct(id) {
    return (
      database
        .prepare(
          `SELECT id, sku, name, category, unit_price_cents AS unitPriceCents,
          unit_cost_cents AS unitCostCents, stock_on_hand AS stockOnHand
        FROM products WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  function getAlerts(filters) {
    const metrics = getDashboard(filters).metrics;
    return database
      .prepare(
        `SELECT id, title, description, metric_key AS metricKey, operator, threshold,
          unit, severity, enabled FROM alert_rules ORDER BY display_order`,
      )
      .all()
      .map((alert) => {
        const value = calculateAlertValue(alert.metricKey, metrics);
        return {
          ...alert,
          enabled: Boolean(alert.enabled),
          value,
          triggered: isAlertTriggered(alert.operator, value, alert.threshold),
        };
      });
  }

  function updateAlert(id, changes) {
    const occurredAt = new Date().toISOString();
    return executeTransaction(database, () => {
      const result = database
        .prepare('UPDATE alert_rules SET threshold = ?, enabled = ? WHERE id = ?')
        .run(changes.threshold, Number(changes.enabled), id);
      if (result.changes > 0) addActivityEvent('alert.updated', occurredAt);
      return result.changes > 0;
    });
  }

  function addActivityEvent(eventName, occurredAt) {
    database
      .prepare('INSERT INTO activity_events (id, event_name, occurred_at) VALUES (?, ?, ?)')
      .run(randomUUID(), eventName, occurredAt);
  }

  function ingestSales(idempotencyKey, now = new Date()) {
    const existing = database
      .prepare(
        `SELECT batch_number AS batchNumber, imported_at AS importedAt, records_added AS recordsAdded
        FROM ingestion_batches WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    if (existing) return { ...existing, replayed: true };

    const batchNumber = Number(
      database.prepare('SELECT COALESCE(MAX(batch_number), 0) + 1 AS nextBatch FROM ingestion_batches').get().nextBatch,
    );
    const importedAt = now.toISOString();
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const dateKey = formatDay(day);
    const products = new Map(model.seed.products.map((product) => [product.id, product]));
    const insertSale = database.prepare(`
      INSERT INTO sales_facts
        (id, receipt_id, store_id, product_id, happened_at, quantity, unit_price_cents, channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let recordsAdded = 0;
    executeTransaction(database, () => {
      model.seed.patterns.forEach((pattern, index) => {
        const product = products.get(pattern.productId);
        if (!product) throw new Error('Configured sales pattern references an unknown product.');
        const happenedAt = new Date(day);
        happenedAt.setUTCHours(pattern.hour, index % 60, 0, 0);
        const result = insertSale.run(
          `ingest-${batchNumber}-${index}`,
          `ingest-${dateKey}-${batchNumber}-${index}`,
          pattern.storeId,
          pattern.productId,
          happenedAt.toISOString(),
          pattern.units,
          product.unitPriceCents,
          pattern.channel,
        );
        recordsAdded += Number(result.changes);
      });
      database
        .prepare(
          `INSERT INTO ingestion_batches (idempotency_key, batch_number, imported_at, records_added)
          VALUES (?, ?, ?, ?)`,
        )
        .run(idempotencyKey, batchNumber, importedAt, recordsAdded);
      addActivityEvent('sales.ingested', importedAt);
    });
    return { batchNumber, importedAt, recordsAdded, replayed: false };
  }

  function getActivity(limit) {
    return database
      .prepare(
        `SELECT event_name AS eventName, occurred_at AS occurredAt
        FROM activity_events ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  function close() {
    database.close();
  }

  return {
    close,
    getActivity,
    getAlerts,
    getDashboard,
    getProduct,
    getProductBreakdown,
    getProducts,
    getStore,
    getStorePerformance,
    ingestSales,
    updateAlert,
  };
}
