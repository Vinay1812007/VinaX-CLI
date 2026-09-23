import { serve } from '@hono/node-server';
import { createApp, GATEWAY_VERSION } from './app.js';
import { ConfigError, loadConfig } from './config.js';

try {
  const config = loadConfig(process.env);
  const server = serve({ fetch: createApp(config).fetch, port: config.port, hostname: '0.0.0.0' });
  console.log(
    JSON.stringify({
      message: `VinaX gateway ${GATEWAY_VERSION} listening`,
      port: config.port,
      providers: Object.keys(config.upstreams),
      tokens: config.tokens.size,
    }),
  );
  const stop = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (err) {
  console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : err);
  process.exit(1);
}
