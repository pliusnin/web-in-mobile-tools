import type { Logger } from '../types';

/** Lifecycle state of the underlying native server, as a readable string. */
export type WebServerState =
  | 'active'
  | 'starting'
  | 'stopping'
  | 'inactive'
  | 'crashed';

export type WebServerStateChange = {
  /** The state the server has just entered. */
  state: WebServerState;
  /** Free-form detail from the native layer, e.g. the `reason` you passed. */
  details?: string;
  /** Set when the server crashed. */
  error?: Error;
};

export type WebServerOptions = {
  /**
   * Absolute path of the directory to serve. Its contents must exist before
   * the first `start()` call — unpack your web app bundle first.
   */
  fileDir: string;

  /**
   * Port to listen on. Omit to let the OS pick a free one; read `origin`
   * after `start()` in that case.
   */
  port?: number;

  /** Interface to bind. Defaults to `localhost` (not reachable from outside). */
  hostname?: string;

  /**
   * Pause the server while the app is in the background, and resume it on
   * foreground. Pass `true` on iOS, where background execution is suspended
   * and a running socket server is killed by the OS anyway; a number is
   * treated as a delay in seconds before pausing.
   *
   * Defaults to `false`, i.e. keep serving in the background.
   */
  stopInBackground?: boolean | number;

  /** Delay used by `stop({ deferred: true })`. Defaults to 5000 ms. */
  deferredStopDelayMs?: number;

  /**
   * Called on every state transition of the server this instance manages,
   * including `starting` and `stopping`. Filter for what you care about.
   */
  onStateChange?: (change: WebServerStateChange) => void;

  /** Where to write diagnostics. Nothing is logged when omitted. */
  logger?: Partial<Logger>;
};
