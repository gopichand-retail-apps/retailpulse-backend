export const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

export function createRange(days, endDate) {
  const endDay = new Date(endDate);
  endDay.setUTCHours(0, 0, 0, 0);
  const start = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  const end = new Date(endDay.getTime() + DAY_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function addDays(date, amount) {
  return new Date(date.getTime() + amount * DAY_MS);
}

export function calculateChange(current, previous) {
  return previous === 0 ? 0 : ((current - previous) / previous) * 100;
}

export function mapMetric(row = {}) {
  const revenueCents = Number(row.revenueCents ?? 0);
  const grossMarginCents = Number(row.grossMarginCents ?? 0);
  return {
    revenueCents,
    transactions: Number(row.transactions ?? 0),
    unitsSold: Number(row.unitsSold ?? 0),
    averageBasketCents: Number(row.averageBasketCents ?? 0),
    grossMarginCents,
    grossMarginPct: revenueCents === 0 ? 0 : (grossMarginCents / revenueCents) * 100,
  };
}

export function mapPerformance(current, previous) {
  const metrics = mapMetric(current);
  const priorMetrics = mapMetric(previous);
  return {
    ...metrics,
    revenueChangePct: calculateChange(metrics.revenueCents, priorMetrics.revenueCents),
    transactionsChangePct: calculateChange(metrics.transactions, priorMetrics.transactions),
    unitsChangePct: calculateChange(metrics.unitsSold, priorMetrics.unitsSold),
    averageBasketChangePct: calculateChange(metrics.averageBasketCents, priorMetrics.averageBasketCents),
  };
}

export function aggregateSales(rows) {
  const receipts = new Map();
  const metric = {
    revenueCents: 0,
    transactions: 0,
    unitsSold: 0,
    grossMarginCents: 0,
  };
  for (const row of rows) {
    const revenue = row.quantity * row.unitPriceCents;
    metric.revenueCents += revenue;
    metric.unitsSold += row.quantity;
    metric.grossMarginCents += row.quantity * (row.unitPriceCents - row.unitCostCents);
    receipts.set(row.receiptId, (receipts.get(row.receiptId) ?? 0) + revenue);
  }
  metric.transactions = receipts.size;
  metric.averageBasketCents =
    receipts.size === 0
      ? 0
      : Math.round([...receipts.values()].reduce((total, value) => total + value, 0) / receipts.size);
  return mapMetric(metric);
}

export function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row[key]) ?? {
      revenueCents: 0,
      unitsSold: 0,
      grossMarginCents: 0,
      receipts: new Set(),
    };
    current.revenueCents += row.quantity * row.unitPriceCents;
    current.unitsSold += row.quantity;
    current.grossMarginCents += row.quantity * (row.unitPriceCents - row.unitCostCents);
    current.receipts.add(row.receiptId);
    grouped.set(row[key], current);
  }
  return grouped;
}

export function groupedMetric(grouped, id) {
  const group = grouped.get(id);
  return mapMetric({
    ...group,
    transactions: group?.receipts.size ?? 0,
    averageBasketCents: group?.receipts.size ? Math.round(group.revenueCents / group.receipts.size) : 0,
  });
}

export function calculateAlertValue(metricKey, metrics) {
  return metrics[metricKey] ?? 0;
}

export function isAlertTriggered(operator, value, threshold) {
  switch (operator) {
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    default:
      return false;
  }
}

export function groupByDay(rows) {
  const days = new Map();
  for (const row of rows) {
    const day = formatDay(new Date(row.happenedAt));
    const current = days.get(day) ?? {
      revenueCents: 0,
      transactions: 0,
      receipts: new Set(),
    };
    current.revenueCents += row.quantity * row.unitPriceCents;
    current.receipts.add(row.receiptId);
    current.transactions = current.receipts.size;
    days.set(day, current);
  }
  return days;
}
