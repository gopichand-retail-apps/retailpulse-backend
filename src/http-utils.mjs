import { randomUUID } from 'node:crypto';

export function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

export function sendCsv(response, status, csv, filename) {
  response.writeHead(status, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  response.end(csv);
}

export function writeLog(entry) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

export function getTraceId(traceparent) {
  const parsed =
    typeof traceparent === 'string' ? /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(traceparent) : null;
  if (parsed && !/^0+$/.test(parsed[1]) && !/^0+$/.test(parsed[2])) {
    return parsed[1].toLowerCase();
  }
  return randomUUID().replaceAll('-', '');
}

function createError(status, code, message) {
  return { status, body: { error: { code, message } } };
}

export function validateFilters(url, model, repository) {
  const selectedRange = model.filters.ranges.find((range) => range.id === url.searchParams.get('range'));
  const daysValue = url.searchParams.get('days');
  const days =
    daysValue === null
      ? (selectedRange?.days ?? model.filters.ranges.find((range) => range.id === model.filters.defaultRangeId).days)
      : Number(daysValue);
  const validDays = model.filters.ranges.some((range) => range.days === days);
  if (!Number.isInteger(days) || !validDays) {
    return {
      error: createError(400, 'INVALID_RANGE', model.copy.errors.invalidRequest),
    };
  }

  const storeId = url.searchParams.get('storeId');
  if (storeId && !repository.getStore(storeId)) {
    return {
      error: createError(404, 'STORE_NOT_FOUND', model.copy.errors.notFound),
    };
  }

  const category = url.searchParams.get('category');
  const validCategory = model.filters.categories.some((item) => item.id === category);
  if (category && !validCategory) {
    return {
      error: createError(400, 'INVALID_CATEGORY', model.copy.errors.invalidRequest),
    };
  }
  return {
    filters: { days, storeId: storeId || null, category: category || null },
  };
}

export function getAllowedOrigins(model) {
  const origin = process.env.RETAILPULSE_E2E_FRONTEND_ORIGIN;
  if (!origin) return model.app.allowedOrigins;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('RETAILPULSE_E2E_FRONTEND_ORIGIN must be an HTTP loopback origin.');
  }
  if (
    parsedOrigin.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(parsedOrigin.hostname) ||
    parsedOrigin.origin !== origin
  ) {
    throw new Error('RETAILPULSE_E2E_FRONTEND_ORIGIN must be an HTTP loopback origin.');
  }
  return [...new Set([...model.app.allowedOrigins, origin])];
}

function csvText(value) {
  return { value, isText: true };
}

function csvNumber(value) {
  return { value, isText: false };
}

function isControlCode(code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function hasSpreadsheetFormulaPrefix(cell) {
  let index = 0;
  while (index < cell.length) {
    const character = cell[index] ?? '';
    if (!/\s/u.test(character) && !isControlCode(character.charCodeAt(0))) break;
    index += 1;
  }
  const firstMeaningfulCharacter = cell[index];
  return firstMeaningfulCharacter !== undefined && '=+-@'.includes(firstMeaningfulCharacter);
}

function hasLeadingControl(cell) {
  const firstCharacter = cell[0];
  return firstCharacter !== undefined && isControlCode(firstCharacter.charCodeAt(0));
}

function escapeCsvCell({ value, isText }) {
  let cell = String(value ?? '');
  if (isText && (hasSpreadsheetFormulaPrefix(cell) || hasLeadingControl(cell))) {
    cell = `'${cell}`;
  }
  return `"${cell.replaceAll('"', '""')}"`;
}

export function createCsv(model, stores, products) {
  const headers = model.reports.csvHeaders.map(csvText);
  const rows = [headers];
  for (const store of stores) {
    rows.push([
      csvText(model.reports.recordTypes.store),
      csvText(store.name),
      csvText(''),
      csvText(''),
      csvNumber((store.revenueCents / 100).toFixed(2)),
      csvNumber(store.transactions),
      csvNumber(store.unitsSold),
      csvNumber((store.grossMarginCents / 100).toFixed(2)),
    ]);
  }
  for (const product of products) {
    rows.push([
      csvText(model.reports.recordTypes.product),
      csvText(product.name),
      csvText(model.filters.categories.find((category) => category.id === product.category)?.label ?? product.category),
      csvText(product.sku),
      csvNumber((product.revenueCents / 100).toFixed(2)),
      csvNumber(product.transactions),
      csvNumber(product.unitsSold),
      csvNumber((product.grossMarginCents / 100).toFixed(2)),
    ]);
  }
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

export async function readJsonBody(request, maximumBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw Object.assign(new Error('Payload too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
