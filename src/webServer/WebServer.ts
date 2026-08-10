import StaticServer, {
  getActiveServer,
  STATES,
} from '@dr.pogodin/react-native-static-server';

import { normalizeLogger, type Logger } from '../types';
import type {
  WebServerOptions,
  WebServerState,
  WebServerStateChange,
} from './types';

const STATE_NAMES: Record<STATES, WebServerState> = {
  [STATES.ACTIVE]: 'active',
  [STATES.CRASHED]: 'crashed',
  [STATES.INACTIVE]: 'inactive',
  [STATES.STARTING]: 'starting',
  [STATES.STOPPING]: 'stopping',
};

const DEFAULT_HOSTNAME = 'localhost';
const DEFAULT_DEFERRED_STOP_DELAY_MS = 5000;

/**
 * A local HTTP server serving a directory of static files to a WebView.
 *
 * Wraps `@dr.pogodin/react-native-static-server` with the lifecycle handling a
 * long-lived app shell needs: reusing a server that is already running, getting
 * back on its feet after a crash, and cancelling a scheduled stop when the app
 * comes back to the foreground.
 *
 * ```ts
 * const server = new WebServer({ fileDir: wwwPath, logger: log });
 * const origin = await server.start('app launch');
 * ```
 */
export class WebServer {
  /** Directory being served. */
  readonly fileDir: string;

  /**
   * Origin of the running server, e.g. `http://localhost:3035`.
   * `null` until the first successful `start()`.
   */
  origin: string | null = null;

  private readonly hostname: string;
  private readonly port: number | undefined;
  private readonly stopInBackground: boolean | number;
  private readonly deferredStopDelayMs: number;
  private readonly onStateChange:
    | ((change: WebServerStateChange) => void)
    | undefined;
  private readonly log: Logger;

  private server: StaticServer;
  private unsubscribeFromState: (() => void) | undefined;
  private stopTimeoutId: number | undefined;

  constructor(options: WebServerOptions) {
    this.fileDir = options.fileDir;
    this.hostname = options.hostname ?? DEFAULT_HOSTNAME;
    this.port = options.port;
    this.stopInBackground = options.stopInBackground ?? false;
    this.deferredStopDelayMs =
      options.deferredStopDelayMs ?? DEFAULT_DEFERRED_STOP_DELAY_MS;
    this.onStateChange = options.onStateChange;
    this.log = normalizeLogger(options.logger);

    this.server = this.resolveServerInstance();
    this.listenToStateChanges();
  }

  /** Current state of the server, as a readable string. */
  get state(): WebServerState {
    return STATE_NAMES[this.server.state];
  }

  /** True while the server is up and answering requests. */
  isRunning(): boolean {
    return this.server.state === STATES.ACTIVE;
  }

  /**
   * Starts the server and resolves with its origin. Safe to call when already
   * running — concurrent calls resolve with the same origin instead of starting
   * a second server. Cancels a pending deferred stop.
   *
   * @param reason Free-form label forwarded to state listeners; use it to tell
   *   apart the code paths that start the server.
   */
  async start(reason?: string): Promise<string> {
    this.cancelDeferredStop();

    this.log.debug(
      '[WebServer] start requested',
      reason ? `(${reason})` : '',
      '- current state:',
      this.state,
    );

    if (this.server.state === STATES.CRASHED) {
      this.log.warn('[WebServer] previous instance crashed, recreating it');
      await this.discardCrashedServer();
    }

    this.origin = await this.server.start(reason);

    return this.origin;
  }

  /**
   * Stops the server.
   *
   * With `deferred: true` the stop is scheduled `deferredStopDelayMs` from now
   * and cancelled by any `start()` in the meantime — the usual way to survive a
   * short trip to the background without tearing the server down. Either way a
   * previously scheduled stop is cancelled first.
   */
  async stop(
    options: { deferred?: boolean; reason?: string } = {},
  ): Promise<void> {
    const { deferred = false, reason } = options;

    this.cancelDeferredStop();

    if (deferred) {
      this.log.debug(
        '[WebServer] stop scheduled in',
        this.deferredStopDelayMs,
        'ms',
        reason ? `(${reason})` : '',
      );
      this.stopTimeoutId = setTimeout(() => {
        this.stopTimeoutId = undefined;
        this.server.stop(reason ?? 'Deferred stop').catch(err => {
          this.log.error('[WebServer] deferred stop failed', err);
        });
      }, this.deferredStopDelayMs);

      return;
    }

    await this.server.stop(reason ?? 'Immediate stop');
  }

  /**
   * Detaches this instance from the server: cancels a pending deferred stop and
   * stops delivering `onStateChange`. Does not stop the server — call `stop()`
   * for that. Use it when the owning component goes away.
   */
  destroy(): void {
    this.cancelDeferredStop();
    this.unsubscribeFromState?.();
    this.unsubscribeFromState = undefined;
  }

  private resolveServerInstance(): StaticServer {
    const running = getActiveServer();

    if (running) {
      this.log.debug(
        '[WebServer] reusing the server which is already running:',
        running.id,
        STATE_NAMES[running.state],
      );

      return running;
    }

    const server = new StaticServer({
      fileDir: this.fileDir,
      hostname: this.hostname,
      port: this.port,
      stopInBackground: this.stopInBackground,
    });
    this.log.debug('[WebServer] created a new server instance:', server.id);

    return server;
  }

  private listenToStateChanges(): void {
    this.unsubscribeFromState?.();
    this.unsubscribeFromState = this.server.addStateListener(
      (state, details, error) => {
        const readableState = STATE_NAMES[state];

        this.log.debug(
          '[WebServer] state changed to',
          readableState,
          details ? `- ${details}` : '',
        );

        if (state === STATES.ACTIVE) {
          this.origin = this.server.origin;
        }

        this.onStateChange?.({ state: readableState, details, error });
      },
    );
  }

  private async discardCrashedServer(): Promise<void> {
    try {
      await this.server.stop('Discarding crashed instance');
    } catch (err) {
      // Nothing to do about it: we are replacing this instance anyway.
      this.log.error('[WebServer] could not stop the crashed instance', err);
    }

    this.destroy();
    this.server = this.resolveServerInstance();
    this.listenToStateChanges();
  }

  private cancelDeferredStop(): void {
    if (this.stopTimeoutId !== undefined) {
      clearTimeout(this.stopTimeoutId);
      this.stopTimeoutId = undefined;
      this.log.debug('[WebServer] pending deferred stop cancelled');
    }
  }
}
