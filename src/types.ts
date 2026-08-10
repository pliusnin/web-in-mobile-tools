/**
 * Minimal logging surface the tools write to.
 *
 * The library never logs on its own: pass your app logger to see anything.
 * Any object with these methods fits, including `console`. Partial objects are
 * accepted too — missing methods are simply skipped.
 */
export type Logger = {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const noop = () => {};

/** Fills in the methods a caller did not provide, so call sites stay simple. */
export const normalizeLogger = (logger?: Partial<Logger>): Logger => ({
  debug: logger?.debug?.bind(logger) ?? noop,
  info: logger?.info?.bind(logger) ?? noop,
  warn: logger?.warn?.bind(logger) ?? noop,
  error: logger?.error?.bind(logger) ?? noop,
});
