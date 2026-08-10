# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — unreleased

Initial extraction from the ManageGo React Native shells.

### Added

- `WebServer`: local static file server for a WebView, wrapping
  `@dr.pogodin/react-native-static-server` with app-shell lifecycle handling —
  adopting an already-running server, replacing a crashed one, and deferred stop
  with cancellation.
- Readable server states (`'active' | 'starting' | 'stopping' | 'inactive' |
'crashed'`) in place of the numeric enum, reported through `onStateChange`.
- `WebAppManager`: installs the web app from the zip bundled in the binary and
  updates it from a URL, unpacking and validating into a staging directory before
  swapping it in.
- Injectable `logger`; the package logs nothing on its own.

### Differences from the in-app implementations this replaces

Intentional, and observable at adoption time.

`WebServer`:

- **State changes are reported for adopted servers too.** The in-app version only
  attached its listener to servers it created itself, so after a JS reload the app
  never learned that the server had come up.
- **`onStateChange` fires for every transition**, not only `active`/`inactive`.
  Filter at the call site — see the README example.
- An immediate `stop()` now cancels a pending deferred stop, so a stale timer cannot
  shut down a server that was restarted in the meantime.

`WebAppManager` merges the two implementations that had drifted apart, taking the
better half of each and closing the gaps both had:

- **From the tenant app:** update unpacks and validates into `<appDir>.next` and
  swaps it in with renames, instead of wiping the served directory and refilling it
  in place. A corrupt download no longer rolls the user back to the version bundled
  in the binary, and the server can no longer answer a navigation with 403/404
  mid-update.
- **From the PMC app:** install gates on `index.html` rather than on the directory's
  existence, so a directory left empty or half-written is repaired on the next launch
  rather than being served as 404s until the app is reinstalled.
- **New:** a failed swap restores the previous app; install clears the target
  directory so a partial extraction is not mixed with fresh files; the stale download
  is removed before and after unzipping; paths are normalised internally, so a
  missing or duplicated trailing slash in `appDir` no longer changes behaviour.
- **New:** concurrent `update()` calls join the running one, which replaces the
  `isUpdating` flag both apps kept in their component.
- **New:** `updateIfNewer()` owns the whole check — probe, compare, download, swap,
  record — so the `checkUpdate` both apps carried in their root component (the
  `HEAD` probe, the version bookkeeping, the throttle, the in-progress flag, and
  four interleaved return paths) reduces to building a URL and reacting to the
  result.
- **New:** the installed version is recorded in a `.webapp-version` file inside the
  app directory instead of in `AsyncStorage`. Both apps could get stuck on a stale
  build because of that split: an app repaired from the bundled archive kept the
  timestamp of the build it no longer had, so the update check reported
  "already up to date" until something newer was published. The marker is now
  swapped in with the files it describes and is absent after a bundled restore.
- **New:** the throttle is per manager instance, so checking one web app no longer
  blocks a check of another — both apps shared a single timestamp field across every
  app directory they managed.
