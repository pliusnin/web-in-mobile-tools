# web-in-mobile-tools

Building blocks for apps whose UI is a web app bundled inside a React Native shell.

If your app ships a web bundle in its assets, unpacks it on first launch, serves it
from a local HTTP server and points a `WebView` at it, this package holds the parts
of that setup which have nothing to do with your product.

Currently included:

- **`WebServer`** — a local static file server for the WebView, with the lifecycle
  handling a long-lived app shell needs.
- **`WebAppManager`** — installs the web app from the zip bundled in your binary and
  updates it from a URL, without ever leaving the served directory broken.

## Requirements

- React Native 0.72 or newer
- **Peer dependencies**, so your app owns the versions and the native build:
  - `@dr.pogodin/react-native-static-server` >= 0.25 — for `WebServer`
  - `react-native-blob-util` >= 0.22 and `react-native-zip-archive` >= 7 — for
    `WebAppManager`

```bash
yarn add web-in-mobile-tools \
  @dr.pogodin/react-native-static-server \
  react-native-blob-util \
  react-native-zip-archive
cd ios && pod install
```

## Quick start

```ts
import { WebServer } from 'web-in-mobile-tools';

const server = new WebServer({ fileDir: `${DocumentDir}/www` });

const origin = await server.start();
// -> http://localhost:52831 — feed it to your WebView
```

That is the whole minimum: a directory to serve, and `start()`. The OS picks a free
port unless you ask for one.

> The directory has to be populated **before** the first `start()`. If you unpack a
> zipped bundle at launch, await that first — a server started over an empty
> directory serves 404s to your WebView.

## Real usage

What an app shell typically wants: a fixed port, its own logger, the server paused
while backgrounded on iOS, and a signal for when it is actually up.

```ts
import { Platform } from 'react-native';
import { WebServer } from 'web-in-mobile-tools';

this.webServer = new WebServer({
  fileDir: wwwPath,
  port: 3035,
  stopInBackground: Platform.OS === 'ios',
  logger: log,
  onStateChange: ({ state }) => {
    if (state === 'active' || state === 'inactive') {
      this.onServerRunningStateChanged(state === 'active');
    }
  },
});

// on launch, once the web bundle is unpacked
await this.webAppUnpacked;
const origin = await this.webServer.start('app launch');

// leaving for the background: give the user a few seconds to come back
await this.webServer.stop({ deferred: true });

// coming back: cancels the pending stop if it has not fired yet
await this.webServer.start('foreground');
```

## API

### `new WebServer(options)`

| Option                | Type                | Default       | Notes                                                                                               |
| --------------------- | ------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `fileDir`             | `string`            | —             | **Required.** Absolute path of the directory to serve.                                              |
| `port`                | `number`            | auto          | Omit to let the OS pick a free port; read `origin` afterwards.                                      |
| `hostname`            | `string`            | `'localhost'` | Interface to bind. The default is not reachable from other devices.                                 |
| `stopInBackground`    | `boolean \| number` | `false`       | Pause while backgrounded, resume on foreground. Pass `true` on iOS. A number is a delay in seconds. |
| `deferredStopDelayMs` | `number`            | `5000`        | Delay used by `stop({ deferred: true })`.                                                           |
| `onStateChange`       | `(change) => void`  | —             | Called on **every** transition, `starting` and `stopping` included.                                 |
| `logger`              | `Partial<Logger>`   | —             | Anything with `debug`/`info`/`warn`/`error`, e.g. `console`. Nothing is logged when omitted.        |

### Instance

| Member           | Type              | Notes                                                                                               |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `start(reason?)` | `Promise<string>` | Starts the server, resolves with the origin. Cancels a pending deferred stop.                       |
| `stop(options?)` | `Promise<void>`   | `{ deferred?: boolean, reason?: string }`. See below.                                               |
| `isRunning()`    | `boolean`         | True while the server answers requests.                                                             |
| `state`          | `WebServerState`  | `'active' \| 'starting' \| 'stopping' \| 'inactive' \| 'crashed'`                                   |
| `origin`         | `string \| null`  | e.g. `http://localhost:3035`. `null` until the first successful `start()`.                          |
| `fileDir`        | `string`          | The directory being served.                                                                         |
| `destroy()`      | `void`            | Stops delivering `onStateChange` and cancels a pending deferred stop. Does **not** stop the server. |

`reason` is a free-form label forwarded to `onStateChange` as `details`. Worth
passing: when a server starts from three different code paths, the logs tell you
which one did it.

## Behaviour worth knowing

**Repeated `start()` is safe.** Calling it while the server is running resolves with
the same origin, and concurrent calls are serialised by the underlying library — the
second caller gets the first caller's origin rather than a second server.

**An already-running server is adopted.** If a native server instance is still alive
— typically after a JS reload in development — the new `WebServer` attaches to it
instead of starting a competing one, and still reports its state changes.

**A crashed server is replaced.** `start()` notices a crashed instance, discards it,
and builds a fresh one before starting.

**Deferred stop is for background trips.** `stop({ deferred: true })` schedules the
stop and returns immediately; any `start()` before the timer fires cancels it. That
keeps a quick app-switch from tearing the server down and forcing a WebView reload.
An immediate `stop()` also cancels a scheduled one, so a stale timer can never take
down a server you have just restarted.

**`stopInBackground` belongs to iOS.** iOS suspends background execution and kills
the listening socket anyway, so pausing deliberately and resuming on foreground is
cleaner than discovering a dead server. Android can keep serving.

## `WebAppManager`

Ships a web app as a zip inside your binary, unpacks it on first launch, and later
replaces it with a build downloaded from a URL.

```ts
import { Platform } from 'react-native';
import { WebAppManager } from 'web-in-mobile-tools';

const webApp = new WebAppManager({
  appDir: `${RNFetchBlob.fs.dirs.DocumentDir}/www/app`,
  bundledZipName: 'webapp.zip',
  platform: Platform.OS,
  minCheckIntervalMs: 60_000,
  logger: log,
});

// on launch, before the server starts
await webApp.install();

// whenever it makes sense to look for a new build — on resume, on navigation
const result = await webApp.updateIfNewer('https://example.com/app/webapp.zip');

if (result.status === 'updated') {
  reloadWebView();
}
```

`updateIfNewer()` does the whole job: asks what is published, compares it with what
is installed, and downloads, validates and swaps only when there is something newer.
Everything it needs is in the options or in the app directory, so you keep no state
of your own — no "last checked" timestamp, no "update in progress" flag.

### `new WebAppManager(options)`

| Option                  | Type                                | Notes                                                                                                           |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `appDir`                | `string`                            | **Required.** Absolute path of the web app directory — the same one you serve. A trailing slash is accepted.    |
| `bundledZipName`        | `string`                            | **Required.** Zip file name inside the binary; also the file name used for the download in the cache directory. |
| `platform`              | `'ios' \| 'android'`                | **Required.** Pass `Platform.OS`. Android looks the zip up in bundled assets, iOS in the main bundle directory. |
| `minCheckIntervalMs`    | `number`                            | Shortest interval between two checks; sooner calls return `'throttled'`. Defaults to `0` — every call checks.   |
| `probePublishedVersion` | `(zipUrl) => Promise<Date \| null>` | Replaces the built-in `HEAD` probe — e.g. to route it through your own networking stack.                        |
| `logger`                | `Partial<Logger>`                   | Nothing is logged when omitted.                                                                                 |

### Instance

| Member                     | Type                         | Notes                                                                                        |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `install()`                | `Promise<void>`              | Unpacks the bundled zip when no usable app is present. No-op once installed.                 |
| `updateIfNewer(zipUrl)`    | `Promise<UpdateCheckResult>` | Check and, if warranted, update. The method to reach for.                                    |
| `update(zipUrl)`           | `Promise<boolean>`           | Unconditional download and swap. `false` when the archive was unusable and the app was kept. |
| `installedVersion()`       | `Promise<Date \| null>`      | Publication date of the installed app; `null` when unknown.                                  |
| `publishedVersion(zipUrl)` | `Promise<Date \| null>`      | Publication date at the URL; `null` when nothing usable is published.                        |
| `isInstalled()`            | `Promise<boolean>`           | Whether a usable app (an `index.html`) is present.                                           |
| `appDir`                   | `string`                     | The managed directory, without a trailing slash.                                             |
| `bundledZipName`           | `string`                     | The bundled archive's file name — handy for building the URL to check.                       |

`UpdateCheckResult` is a discriminated union on `status`:

| `status`        | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `updated`       | Newer archive downloaded and swapped in. Carries `version: Date`. |
| `up-to-date`    | What is installed is already as new as what is published.         |
| `not-published` | Nothing usable published at that URL.                             |
| `rejected`      | Newer archive downloaded but unusable; installed app kept.        |
| `throttled`     | Checked again within `minCheckIntervalMs`; nothing was done.      |

### Behaviour worth knowing

**The installed version lives with the app.** It is recorded in a `.webapp-version`
file inside `appDir` and swapped in together with the files it describes, so the two
cannot drift apart. An app restored from the bundled archive therefore reports **no**
version — which is the point: it gets updated again on the next check instead of
claiming to be a build it no longer is.

**The default probe is a `HEAD` request.** `last-modified` is the publication date.
It resolves `null` — "nothing usable published" — on a failed request, on a response
that does not look like a zip (an error page served with HTTP 200 included), or when
`last-modified` is missing. Header lookup goes through the `Headers` API, which is
case-insensitive: response header casing is not consistent across platforms.

**The throttle clock starts on every check**, successful or not, so a failing server
is not hammered. It is per instance, so one app's check never blocks another's.

**Install repairs, not just installs.** `install()` checks for `index.html` rather
than for the directory, so a directory left empty or half-written by an interrupted
run is repaired on the next launch instead of being served as 404s forever. It also
clears the directory before unpacking, so a partial extraction is never mixed with
the fresh files.

**A bad download costs nothing.** The archive is unpacked into `<appDir>.next` and
validated there. If it has no `index.html`, staging is discarded and the installed
app stays untouched — no rollback to the version bundled in the binary. The bundled
zip is only reinstalled when there is no usable app at all.

**The served directory is never half-written.** The staged app is swapped in with two
renames (`appDir` → `.old`, `.next` → `appDir`), so the directory is briefly _absent_
rather than incomplete for the duration of an unzip. If the second rename fails, the
previous app is moved back. Leftover `.next`/`.old` directories from a killed process
are cleaned at the start of the next update.

**Concurrent updates are joined.** A second update while one is running returns the
running one's promise rather than starting another download, so callers don't need
their own in-progress flag.

**Unusable archives resolve, the unexpected throws.** A corrupt download is a
`'rejected'` (or `false` from `update()`); network and filesystem failures throw, with
the installed app left working.

**`update()` leaves the version unknown**, since it is given no version to record, so
the next `updateIfNewer()` downloads again. Reach for it only to force a reinstall.

**Validation is a presence check.** `index.html` existing is the only test — there is
no checksum or signature verification, so a corrupt archive that happens to contain
an `index.html` will be installed.

## Roadmap

Modules queued for extraction from the apps already using this pattern:

- `httpRequests` — routing WebView `fetch` calls through native networking
- `secureStorage` — keychain-backed token and credential storage
- `base64`, `logger` — the small shared utilities

## License

MIT © Dmitry Pliusnin
