import pino, { type Logger as PinoLogger } from "pino";
import type { Logger } from "@qansa/services";

/**
 * Pretty output is a development convenience, never a requirement: a
 * production image does not ship pino-pretty, so a missing transport must not
 * stop the worker from booting.
 */
export function createLogger(options: { level: string; pretty: boolean }): { base: PinoLogger; logger: Logger } {
  let base: PinoLogger;
  try {
    base = options.pretty
      ? pino({ level: options.level, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } })
      : pino({ level: options.level });
  } catch {
    base = pino({ level: options.level });
  }

  return {
    base,
    logger: {
      info: (context, message) => base.info(context, message),
      warn: (context, message) => base.warn(context, message),
      error: (context, message) => base.error(context, message),
      debug: (context, message) => base.debug(context, message),
    },
  };
}
