import {
  FunctionRunner,
  newGrpcServer,
  startServer,
} from '@crossplane-org/function-sdk-typescript';
import pino from 'pino';
import { CompositionHandler } from './handler.js';
import { DispatchLoader } from './loader/dispatch.js';

const address = process.env.ADDRESS ?? '0.0.0.0:9443';
const tlsDir = process.env.TLS_SERVER_CERTS_DIR ?? process.env.TLS_DIR ?? '/tls/server';
const insecure = process.env.INSECURE === 'true';
const debug = process.env.DEBUG === 'true';

const logger = pino({
  level: debug ? 'debug' : 'info',
  timestamp: false,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
  base: undefined,
});

const loader = new DispatchLoader();
const handler = new CompositionHandler(loader);
const runner = new FunctionRunner(handler, logger);
const server = newGrpcServer(runner, logger);

startServer(
  server,
  {
    address,
    ...(insecure ? { insecure: true } : { tlsServerCertsDir: tlsDir }),
  },
  logger,
);
