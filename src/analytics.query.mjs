function getConditions(filters, range) {
  const conditions = ['s.happened_at >= ?', 's.happened_at < ?'];
  const values = [range.start, range.end];
  if (filters.storeId) {
    conditions.push('s.store_id = ?');
    values.push(filters.storeId);
  }
  if (filters.category) {
    conditions.push('p.category = ?');
    values.push(filters.category);
  }
  return { sql: conditions.join(' AND '), values };
}

export function getSalesRows(database, filters, range) {
  const conditions = getConditions(filters, range);
  return database
    .prepare(
      `SELECT s.store_id AS groupId, s.product_id AS productId, s.happened_at AS happenedAt,
        s.receipt_id AS receiptId, s.quantity, s.unit_price_cents AS unitPriceCents,
        p.unit_cost_cents AS unitCostCents, p.category
      FROM sales_facts s
      JOIN products p ON p.id = s.product_id
      WHERE ${conditions.sql}`,
    )
    .all(...conditions.values);
}

/**
 * Committed-sale activity behind the source summary. The cutoff is the latest sale at or before `now`;
 * coverage counts days with any sale in the period, whatever store or category filter is applied.
 */
export function getSourceActivity(database, { filters, range, now }) {
  const scope = getConditions(filters, range);
  const totals = database
    .prepare(
      `SELECT COUNT(*) AS totalSales, MAX(CASE WHEN happened_at <= ? THEN happened_at END) AS lastSaleAt
      FROM sales_facts`,
    )
    .get(now.toISOString());
  const inScope = database
    .prepare(
      `SELECT COUNT(*) AS scopeSales
      FROM sales_facts s JOIN products p ON p.id = s.product_id
      WHERE ${scope.sql}`,
    )
    .get(...scope.values);
  const covered = database
    .prepare(
      `SELECT COUNT(DISTINCT substr(happened_at, 1, 10)) AS daysWithSales
      FROM sales_facts WHERE happened_at >= ? AND happened_at < ?`,
    )
    .get(range.start, range.end);
  return {
    totalSales: Number(totals.totalSales),
    lastSaleAt: totals.lastSaleAt ?? null,
    scopeSales: Number(inScope.scopeSales),
    daysWithSales: Number(covered.daysWithSales),
  };
}

export function getProductConditions(filters, range) {
  return getConditions({ ...filters, category: undefined }, range);
}
