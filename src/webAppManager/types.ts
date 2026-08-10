import type { Logger } from '../types';

export type WebAppManagerOptions = {
  /**
   * Absolute path of the directory the web app lives in — the same directory
   * the local server serves. A trailing slash is accepted but not required.
   */
  appDir: string;

  /**
   * File name of the zip archive shipped inside the app binary, e.g.
   * `'webapp.zip'`. On Android it is looked up in the bundled assets, on iOS in
   * the main bundle directory. The same name is reused for the download in the
   * cache directory.
   */
  bundledZipName: string;

  /** Pass `Platform.OS` — it decides where the bundled zip is looked up. */
  platform: 'ios' | 'android';

  /**
   * Shortest interval between two `updateIfNewer()` checks. Calls made sooner
   * resolve with `'throttled'` without touching the network. The clock starts on
   * every check, successful or not, so a failing server is not hammered.
   *
   * Defaults to `0` — every call checks.
   */
  minCheckIntervalMs?: number;

  /**
   * Replaces the built-in "is a newer archive published?" probe, which issues a
   * `HEAD` request and reads `last-modified`. Provide your own to route the probe
   * through your app's networking stack, or to read the version from an endpoint
   * of your own instead.
   *
   * Resolve with the publication date, or `null` when nothing usable is
   * published at that URL.
   */
  probePublishedVersion?: (zipUrl: string) => Promise<Date | null>;

  /** Where to write diagnostics. Nothing is logged when omitted. */
  logger?: Partial<Logger>;
};

/** Outcome of `WebAppManager.updateIfNewer()`. */
export type UpdateCheckResult =
  /** A newer archive was published, downloaded and swapped in. */
  | { status: 'updated'; version: Date }
  /** What is installed is already as new as what is published. */
  | { status: 'up-to-date' }
  /** Nothing usable is published at that URL. */
  | { status: 'not-published' }
  /** A newer archive was downloaded but unusable; the installed app was kept. */
  | { status: 'rejected' }
  /** Checked again within `minCheckIntervalMs`; nothing was done. */
  | { status: 'throttled' };
