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

export function getProductConditions(filters, range) {
  return getConditions({ ...filters, category: undefined }, range);
}
