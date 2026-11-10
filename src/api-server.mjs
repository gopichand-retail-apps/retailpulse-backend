import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { createAnalyticsRepository } from './analytics.repository.mjs';
import { APP_VERSION } from './app-version.mjs';
import { handleApiRequest } from './api-routes.mjs';
import { loadModel } from './model.mjs';
import { getAllowedOrigins, getTraceId, sendCsv, sendJson, writeLog } from './http-utils.mjs';

function createRequestContext(response, requestId) {
  const state = {
    responseStatus: 500,
    errorCode: undefined,
  };
  return {
    requestId,
    routeTemplate: '/api/v1/unmatched',
    get responseStatus() {
      return state.responseStatus;
    },
    get errorCode() {
      return state.errorCode;
    },
    complete: (status, body) => {
      state.responseStatus = status;
      state.errorCode = status >= 400 ? body?.error?.code : undefined;
      sendJson(response, status, body);
    },
    completeCsv: (status, csv, filename) => {
      state.responseStatus = status;
      sendCsv(response, status, csv, filename);
    },
    completeNoContent: () => {
      state.responseStatus = 204;
    },
  };
}

function setSecurityHeaders(response, requestId, traceId) {
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('X-Trace-ID', traceId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
}

function applyCors({ request, response, context, model, allowedOrigins }) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) {
    context.complete(403, {
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: model.copy.errors.originNotAllowed,
        requestId: context.requestId,
      },
    });
    return false;
  }

  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, traceparent');
  response.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-Trace-ID');
  return true;
}

function handleOptions(response, context) {
  context.completeNoContent();
  response.writeHead(204);
  response.end();
}

function handleApiError(error, context, model) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR';
  context.complete(status, {
    error: {
      code,
      message: status === 500 ? model.copy.errors.server : model.copy.errors.invalidRequest,
      requestId: context.requestId,
    },
  });
}

function writeRequestLog(request, context, traceId, startedAt) {
  const { responseStatus, errorCode, requestId, routeTemplate } = context;
  writeLog({
    level: responseStatus >= 500 ? 'ERROR' : responseStatus >= 400 ? 'WARN' : 'INFO',
    service: 'retailpulse-api',
    version: APP_VERSION,
    eventName: responseStatus >= 400 ? 'api.request.failed' : 'api.request.completed',
    requestId,
    traceId,
    method: request.method,
    routeTemplate,
    status: responseStatus,
    durationMs: Math.round(performance.now() - startedAt),
    outcome: responseStatus < 400 ? 'success' : 'failure',
    ...(errorCode ? { errorCode } : {}),
  });
}

async function handleHttpRequest({ request, response, model, repository, allowedOrigins }) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const traceId = getTraceId(request.headers.traceparent);
  const context = createRequestContext(response, requestId);
  setSecurityHeaders(response, requestId, traceId);

  try {
    if (!applyCors({ request, response, context, model, allowedOrigins })) return;
    if (request.method === 'OPTIONS') {
      handleOptions(response, context);
      return;
    }
    await handleApiRequest({ request, response, context, model, repository });
  } catch (error) {
    handleApiError(error, context, model);
  } finally {
    writeRequestLog(request, context, traceId, startedAt);
  }
}

export function createApiServer({ databasePath = 'data/retailpulse.sqlite', model = loadModel() } = {}) {
  const allowedOrigins = getAllowedOrigins(model);
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  const repository = createAnalyticsRepository({ databasePath, model });
  const server = createServer((request, response) =>
    handleHttpRequest({ request, response, model, repository, allowedOrigins }),
  );

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          repository.close();
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
