import RNFetchBlob from 'react-native-blob-util';
import { unzip } from 'react-native-zip-archive';

import { normalizeLogger, type Logger } from '../types';
import { probePublishedVersion as defaultProbe } from './probePublishedVersion';
import type { UpdateCheckResult, WebAppManagerOptions } from './types';

const INDEX_FILE = 'index.html';
const VERSION_FILE = '.webapp-version';
const STAGING_SUFFIX = '.next';
const BACKUP_SUFFIX = '.old';

const stripTrailingSlashes = (path: string): string => path.replace(/\/+$/, '');

const joinPath = (dir: string, name: string): string =>
  `${stripTrailingSlashes(dir)}/${name}`;

/**
 * Installs and updates a web app that ships as a zip archive inside the app
 * binary and is later refreshed from a URL.
 *
 * Two guarantees shape the implementation, because the managed directory is the
 * one a local server is serving to a live WebView:
 *
 * - **A failed update is a no-op.** The download is unpacked and validated in a
 *   staging directory before it replaces anything, so a truncated or corrupt
 *   archive leaves the working app in place instead of rolling the user back to
 *   whatever version shipped in the binary.
 * - **The served directory is never half-written.** It is swapped in by renames
 *   rather than emptied and refilled, so the server cannot answer a navigation
 *   with a 403/404 mid-update.
 *
 * The installed version is recorded inside the app directory, so it is swapped in
 * with the files it describes and cannot outlive them — an app restored from the
 * bundled archive reports no version and is updated again on the next check.
 *
 * ```ts
 * const webApp = new WebAppManager({
 *   appDir: `${DocumentDir}/www/app`,
 *   bundledZipName: 'webapp.zip',
 *   platform: Platform.OS,
 *   minCheckIntervalMs: 60_000,
 *   logger: log,
 * });
 *
 * await webApp.install();                         // before the server starts
 * const result = await webApp.updateIfNewer(zipUrl);
 * ```
 */
export class WebAppManager {
  /** Directory the web app is installed into, without a trailing slash. */
  readonly appDir: string;

  /** File name of the archive bundled with the binary. */
  readonly bundledZipName: string;

  private readonly platform: 'ios' | 'android';
  private readonly minCheckIntervalMs: number;
  private readonly probe: (zipUrl: string) => Promise<Date | null>;
  private readonly log: Logger;
  private readonly stagingDir: string;
  private readonly backupDir: string;

  private updateInFlight: Promise<boolean> | undefined;
  private lastCheckAt: number | undefined;

  constructor(options: WebAppManagerOptions) {
    this.appDir = stripTrailingSlashes(options.appDir);
    this.bundledZipName = options.bundledZipName;
    this.platform = options.platform;
    this.minCheckIntervalMs = options.minCheckIntervalMs ?? 0;
    this.probe = options.probePublishedVersion ?? defaultProbe;
    this.log = normalizeLogger(options.logger);
    this.stagingDir = `${this.appDir}${STAGING_SUFFIX}`;
    this.backupDir = `${this.appDir}${BACKUP_SUFFIX}`;
  }

  /** True when a usable web app (an `index.html`) is present. */
  async isInstalled(): Promise<boolean> {
    return this.isValidApp(this.appDir);
  }

  /**
   * Publication date of the installed app, or `null` when it is unknown — which
   * is the case for an app unpacked from the bundled archive, and for one
   * installed by a bare `update()` call.
   */
  async installedVersion(): Promise<Date | null> {
    const versionPath = joinPath(this.appDir, VERSION_FILE);

    if (!(await RNFetchBlob.fs.exists(versionPath))) {
      return null;
    }

    try {
      const raw = await RNFetchBlob.fs.readFile(versionPath, 'utf8');
      const timestamp = Number(String(raw).trim());

      return Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp)
        : null;
    } catch (err) {
      this.log.warn('[WebAppManager] could not read the version marker', err);

      return null;
    }
  }

  /**
   * Publication date of the archive at `zipUrl`, or `null` when nothing usable is
   * published there. Uses the probe from the options, or a `HEAD` request.
   */
  async publishedVersion(zipUrl: string): Promise<Date | null> {
    return this.probe(zipUrl);
  }

  /**
   * Makes sure a usable web app is present, unpacking the bundled archive when
   * it is not. Safe to call on every launch: it is a no-op once installed, and
   * it repairs a directory left empty or half-written by an interrupted run.
   */
  async install(): Promise<void> {
    if (await this.isInstalled()) {
      return;
    }

    this.log.debug('[WebAppManager] installing the bundled web app');

    const bundledZip =
      this.platform === 'android'
        ? RNFetchBlob.fs.asset(this.bundledZipName)
        : joinPath(RNFetchBlob.fs.dirs.MainBundleDir, this.bundledZipName);
    const targetZip = joinPath(this.appDir, this.bundledZipName);

    // Start from an empty directory: leftovers of a partial extraction must not
    // be mixed with the files we are about to unpack. This also drops a version
    // marker left by a previous install — the bundled archive's date is unknown.
    await this.recreateDir(this.appDir);

    await RNFetchBlob.fs.cp(bundledZip, targetZip);
    await unzip(targetZip, this.appDir, 'UTF-8');
    await this.removeIfExists(targetZip);

    this.log.debug('[WebAppManager] bundled web app installed');
  }

  /**
   * Replaces the installed app with the archive at `zipUrl`, but only when that
   * archive is newer than what is installed.
   *
   * The whole check — is anything published, is it newer, download, validate,
   * swap, record the new version — happens here. Everything it needs to know is
   * either in the options or in the app directory, so callers keep no state of
   * their own: no "last checked" timestamp, no "update in progress" flag.
   *
   * Throws only on unexpected failures (network, filesystem). The installed app
   * is left working in that case.
   */
  async updateIfNewer(zipUrl: string): Promise<UpdateCheckResult> {
    if (this.isThrottled()) {
      this.log.debug('[WebAppManager] check skipped, called again too soon');

      return { status: 'throttled' };
    }
    this.lastCheckAt = Date.now();

    const published = await this.publishedVersion(zipUrl);

    if (!published) {
      this.log.debug('[WebAppManager] nothing published at', zipUrl);

      return { status: 'not-published' };
    }

    const installed = await this.installedVersion();
    this.log.debug(
      '[WebAppManager] installed:',
      installed?.toISOString() ?? 'unknown',
      '- published:',
      published.toISOString(),
    );

    if (installed && installed.valueOf() >= published.valueOf()) {
      return { status: 'up-to-date' };
    }

    const replaced = await this.startUpdate(zipUrl, published);

    return replaced
      ? { status: 'updated', version: published }
      : { status: 'rejected' };
  }

  /**
   * Downloads a web app archive and swaps it in, resolving `true` when the app
   * was replaced and `false` when the download turned out to be unusable and
   * the current app was kept.
   *
   * Leaves the installed version unknown, so the next `updateIfNewer()` downloads
   * again. Prefer `updateIfNewer()` unless you are deliberately forcing a
   * reinstall.
   *
   * Calling this while an update is running joins the running one instead of
   * starting a second download.
   *
   * Throws only on unexpected failures (network, filesystem). The installed app
   * is left working in that case.
   */
  async update(zipUrl: string): Promise<boolean> {
    return this.startUpdate(zipUrl);
  }

  private isThrottled(): boolean {
    return (
      this.minCheckIntervalMs > 0 &&
      this.lastCheckAt !== undefined &&
      Date.now() - this.lastCheckAt < this.minCheckIntervalMs
    );
  }

  private async startUpdate(zipUrl: string, version?: Date): Promise<boolean> {
    if (this.updateInFlight) {
      this.log.warn('[WebAppManager] update already running, joining it');

      return this.updateInFlight;
    }

    this.updateInFlight = this.runUpdate(zipUrl, version).finally(() => {
      this.updateInFlight = undefined;
    });

    return this.updateInFlight;
  }

  private async runUpdate(zipUrl: string, version?: Date): Promise<boolean> {
    this.log.debug('[WebAppManager] update started from', zipUrl);

    const downloadPath = joinPath(
      RNFetchBlob.fs.dirs.CacheDir,
      this.bundledZipName,
    );

    // Anything left over from an interrupted run, including a stale download
    // occupying the destination path.
    await this.removeIfExists(this.stagingDir);
    await this.removeIfExists(this.backupDir);
    await this.removeIfExists(downloadPath);

    await RNFetchBlob.config({
      fileCache: true,
      path: downloadPath,
    }).fetch('GET', zipUrl);
    this.log.debug('[WebAppManager] downloaded to', downloadPath);

    try {
      await RNFetchBlob.fs.mkdir(this.stagingDir);
      await unzip(downloadPath, this.stagingDir, 'UTF-8');
    } catch (err) {
      await this.removeIfExists(this.stagingDir);
      throw err;
    } finally {
      await this.removeIfExists(downloadPath);
    }

    // Validate before touching the app currently being served.
    if (!(await this.isValidApp(this.stagingDir))) {
      this.log.warn(
        '[WebAppManager] downloaded archive has no',
        INDEX_FILE,
        '- keeping the installed app',
      );
      await this.removeIfExists(this.stagingDir);

      // Nothing usable installed either (first run, or a previous failure):
      // fall back to the archive bundled with the binary.
      if (!(await this.isInstalled())) {
        this.log.warn('[WebAppManager] no usable app present, reinstalling it');
        await this.install();
      }

      return false;
    }

    // Written into the staging directory so the marker is swapped in together
    // with the files it describes.
    if (version) {
      await RNFetchBlob.fs.writeFile(
        joinPath(this.stagingDir, VERSION_FILE),
        String(version.valueOf()),
        'utf8',
      );
    }

    await this.swapInStagedApp();

    this.log.debug('[WebAppManager] update complete');

    return true;
  }

  /**
   * Moves the staged app into place. Two renames, so the served directory is
   * missing for a moment rather than incomplete for seconds — and if the second
   * rename fails, the previous app is put back.
   */
  private async swapInStagedApp(): Promise<void> {
    const hadInstalledApp = await RNFetchBlob.fs.exists(this.appDir);

    if (hadInstalledApp) {
      await RNFetchBlob.fs.mv(this.appDir, this.backupDir);
    }

    try {
      await RNFetchBlob.fs.mv(this.stagingDir, this.appDir);
    } catch (err) {
      if (hadInstalledApp && !(await RNFetchBlob.fs.exists(this.appDir))) {
        this.log.error(
          '[WebAppManager] swap failed, restoring the previous app',
          err,
        );
        await RNFetchBlob.fs.mv(this.backupDir, this.appDir);
      }

      throw err;
    }

    await this.removeIfExists(this.backupDir);
  }

  private async isValidApp(dir: string): Promise<boolean> {
    return RNFetchBlob.fs.exists(joinPath(dir, INDEX_FILE));
  }

  private async recreateDir(dir: string): Promise<void> {
    await this.removeIfExists(dir);
    await RNFetchBlob.fs.mkdir(dir);
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await RNFetchBlob.fs.exists(path)) {
      await RNFetchBlob.fs.unlink(path);
    }
  }
}
