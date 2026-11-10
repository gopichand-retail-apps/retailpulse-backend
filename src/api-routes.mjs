import { createRange } from './analytics.metrics.mjs';
import { APP_VERSION } from './app-version.mjs';
import { createCsv, readJsonBody, validateFilters } from './http-utils.mjs';

const routes = [
  { method: 'GET', pattern: /^\/api\/v1\/health$/, template: '/api/v1/health', handler: getHealth },
  { method: 'GET', pattern: /^\/api\/v1\/version$/, template: '/api/v1/version', handler: getVersion },
  { method: 'GET', pattern: /^\/api\/v1\/dashboard$/, template: '/api/v1/dashboard', handler: getDashboard },
  { method: 'GET', pattern: /^\/api\/v1\/stores$/, template: '/api/v1/stores', handler: getStores },
  { method: 'GET', pattern: /^\/api\/v1\/stores\/([^/]+)$/, template: '/api/v1/stores/:storeId', handler: getStore },
  { method: 'GET', pattern: /^\/api\/v1\/products$/, template: '/api/v1/products', handler: getProducts },
  {
    method: 'GET',
    pattern: /^\/api\/v1\/products\/([^/]+)$/,
    template: '/api/v1/products/:productId',
    handler: getProduct,
  },
  { method: 'GET', pattern: /^\/api\/v1\/alerts$/, template: '/api/v1/alerts', handler: getAlerts },
  {
    method: 'PATCH',
    pattern: /^\/api\/v1\/alerts\/([^/]+)$/,
    template: '/api/v1/alerts/:alertId',
    handler: patchAlert,
  },
  { method: 'GET', pattern: /^\/api\/v1\/activity$/, template: '/api/v1/activity', handler: getActivity },
  { method: 'POST', pattern: /^\/api\/v1\/sales\/ingest$/, template: '/api/v1/sales/ingest', handler: postIngestion },
  { method: 'GET', pattern: /^\/api\/v1\/reports\/export$/, template: '/api/v1/reports/export', handler: getExport },
];

function getHealth({ complete, model }) {
  complete(200, {
    data: {
      status: 'ok',
      service: 'retailpulse-api',
      storage: 'sqlite',
      application: model.app.name,
    },
  });
}

function getVersion({ complete }) {
  complete(200, { data: { service: 'retailpulse-api', version: APP_VERSION } });
}

function getDashboard({ complete, repository, filters }) {
  complete(200, { data: repository.getDashboard(filters) });
}

function getStores({ complete, repository, filters, ranges }) {
  complete(200, { data: repository.getStorePerformance(filters, ranges) });
}

function getStore({ complete, repository, filters, ranges, model, parameters, requestId }) {
  const storeId = decodeURIComponent(parameters[0]);
  const store = repository.getStore(storeId);
  if (!store) {
    completeErrorWithId(complete, {
      requestId,
      status: 404,
      code: 'STORE_NOT_FOUND',
      message: model.copy.errors.notFound,
    });
    return;
  }
  const scopedFilters = { ...filters, storeId };
  const performance = repository.getStorePerformance(scopedFilters, ranges)[0];
  const dashboard = repository.getDashboard(scopedFilters);
  complete(200, {
    data: { ...store, ...performance, series: dashboard.series, categories: dashboard.categories },
  });
}

function getProducts({ complete, repository, filters, ranges, model, requestUrl, requestId }) {
  const sortBy = requestUrl.searchParams.get('sort') ?? 'revenue';
  if (!['revenue', 'units', 'name', 'stock'].includes(sortBy)) {
    completeErrorWithId(complete, {
      requestId,
      status: 400,
      code: 'INVALID_SORT',
      message: model.copy.errors.invalidRequest,
    });
    return;
  }
  const search = (requestUrl.searchParams.get('search') ?? '').trim().toLowerCase();
  const products = repository
    .getProducts(filters, ranges, sortBy)
    .filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(search));
  complete(200, { data: products });
}

function getProduct({ complete, repository, filters, ranges, model, parameters, requestId }) {
  const product = repository.getProduct(decodeURIComponent(parameters[0]));
  if (!product) {
    completeErrorWithId(complete, {
      requestId,
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
      message: model.copy.errors.notFound,
    });
    return;
  }
  const products = repository.getProducts({ ...filters, category: product.category }, ranges);
  const performance = products.find((item) => item.id === product.id);
  complete(200, { data: { ...product, ...performance } });
}

function getAlerts({ complete, repository, filters }) {
  complete(200, { data: repository.getAlerts(filters) });
}

async function patchAlert({ complete, repository, model, filters, request, parameters, requestId }) {
  const alertId = decodeURIComponent(parameters[0]);
  const body = await readJsonBody(request, model.validation.maximumRequestBytes);
  if (!isValidAlertUpdate(body, model)) {
    completeErrorWithId(complete, {
      requestId,
      status: 400,
      code: 'INVALID_ALERT',
      message: model.copy.errors.invalidRequest,
    });
    return;
  }
  const { threshold, enabled } = body;
  if (!repository.updateAlert(alertId, { threshold, enabled })) {
    completeErrorWithId(complete, {
      requestId,
      status: 404,
      code: 'ALERT_NOT_FOUND',
      message: model.copy.errors.notFound,
    });
    return;
  }
  complete(200, { data: repository.getAlerts(filters).find((item) => item.id === alertId) });
}

function isValidAlertUpdate(body, model) {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof body.threshold === 'number' &&
    Number.isFinite(body.threshold) &&
    body.threshold >= model.validation.minimumAlertThreshold &&
    body.threshold <= model.validation.maximumAlertThreshold &&
    typeof body.enabled === 'boolean'
  );
}

function getActivity({ complete, repository, model }) {
  complete(200, { data: repository.getActivity(model.validation.maximumActivityItems) });
}

function postIngestion({ complete, repository, request, requestId, model }) {
  const idempotencyKey = request.headers['idempotency-key'];
  if (!isValidIdempotencyKey(idempotencyKey)) {
    completeErrorWithId(complete, {
      requestId,
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: model.copy.errors.invalidRequest,
    });
    return;
  }
  const result = repository.ingestSales(idempotencyKey);
  complete(result.replayed ? 200 : 201, { data: result });
}

function isValidIdempotencyKey(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function getExport({ completeCsv, repository, filters, ranges, model }) {
  const dashboard = repository.getDashboard(filters);
  const csv = createCsv(model, dashboard.stores, repository.getProducts(filters, ranges));
  completeCsv(200, csv, model.app.exportFilename);
}

function completeErrorWithId(complete, { requestId, status, code, message }) {
  complete(status, { error: { code, message, requestId } });
}

export async function handleApiRequest({ request, context, model, repository }) {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = routes.find(
    (candidate) => candidate.method === request.method && candidate.pattern.test(requestUrl.pathname),
  );
  const isMetadataRoute = ['/api/v1/health', '/api/v1/version'].includes(route?.template);
  let filters = null;
  let ranges = null;

  if (!isMetadataRoute) {
    const parsedFilters = validateFilters(requestUrl, model, repository);
    if (parsedFilters.error) {
      completeErrorWithId(context.complete, {
        requestId: context.requestId,
        status: parsedFilters.error.status,
        code: parsedFilters.error.body.error.code,
        message: parsedFilters.error.body.error.message,
      });
      return;
    }
    filters = parsedFilters.filters;
    ranges = createReportRanges(filters.days);
  }

  if (!route) {
    completeErrorWithId(context.complete, {
      requestId: context.requestId,
      status: 404,
      code: 'NOT_FOUND',
      message: model.copy.errors.notFound,
    });
    return;
  }

  context.routeTemplate = route.template;
  const match = route.pattern.exec(requestUrl.pathname);
  await route.handler({
    ...context,
    request,
    model,
    repository,
    requestUrl,
    filters,
    ranges,
    parameters: match?.slice(1) ?? [],
  });
}

function createReportRanges(days) {
  const current = createRange(days, new Date());
  const previous = createRange(days, new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  return { current, previous };
}
