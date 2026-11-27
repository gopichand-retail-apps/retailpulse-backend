import { fileURLToPath } from 'node:url';
import { parseProfile } from './analytics.source.mjs';
import { APP_VERSION } from './app-version.mjs';
import { createApiServer, loadModel } from './server.mjs';

const api = createApiServer({
  databasePath:
    process.env.RETAILPULSE_DB_PATH ?? fileURLToPath(new URL('../data/retailpulse.sqlite', import.meta.url)),
  model: loadModel(),
  profile: parseProfile(process.env.RETAILPULSE_PROFILE),
});
const port = Number(process.env.PORT ?? 5702);

api.server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      service: 'retailpulse-api',
      version: APP_VERSION,
      eventName: 'service.started',
      port,
      storage: 'sqlite',
      profile: api.profile,
    })}\n`,
  );
});

const shutdown = () => {
  api
    .close()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`API shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
