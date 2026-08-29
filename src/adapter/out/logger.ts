import pino from 'pino';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function buildPrettyStream(): Writable {
  const require = createRequire(import.meta.url);
  const { prettyFactory } = require('pino-pretty') as typeof import('pino-pretty');
  const prettify = prettyFactory({ translateTime: 'yyyy-mm-dd HH:MM:ss.l', ignore: 'pid,hostname' });

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      process.stdout.write(prettify(chunk.toString()));
      callback();
    },
  });
}

const rootLogger = pino(
  {
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  process.stdout.isTTY ? buildPrettyStream() : undefined,
);

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export default rootLogger;
