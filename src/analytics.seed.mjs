import { formatDay } from './analytics.metrics.mjs';

export function seedSales(database, model, now) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO sales_facts
      (id, receipt_id, store_id, product_id, happened_at, quantity, unit_price_cents, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const products = new Map(model.seed.products.map((product) => [product.id, product]));
  for (let dayOffset = model.seed.salesDays - 1; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - dayOffset);
    const dateKey = formatDay(day);
    model.seed.patterns.forEach((pattern, index) => {
      const product = products.get(pattern.productId);
      if (!product) throw new Error('Configured sales pattern references an unknown product.');
      const happenedAt = new Date(day);
      happenedAt.setUTCHours(pattern.hour, (dayOffset + index) % 60, 0, 0);
      const spread = model.seed.maxUnitsVariation;
      const variation = ((dayOffset + index) % spread) - Math.floor(spread / 2);
      const quantity = Math.max(1, pattern.units + variation);
      insert.run(
        `seed-${dateKey}-${index}`,
        `seed-${dateKey}-${index}`,
        pattern.storeId,
        pattern.productId,
        happenedAt.toISOString(),
        quantity,
        product.unitPriceCents,
        pattern.channel,
      );
    });
  }
}
