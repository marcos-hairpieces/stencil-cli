# `stencil serve` — a headless server command for preview deployments

**Date:** 2026-08-04
**Status:** Approved, ready for implementation
**Target:** upstream `bigcommerce/stencil-cli`

## Problem

`stencil start` is a development command. It assumes a developer at a terminal on a
workstation, and everything it does reflects that: BrowserSync with live reload, five
filesystem watchers, an interactive channel picker, a `rs`-to-reload stdin listener, and
dev-only debug affordances in the rendered output.

People run it in preview deployments anyway, because it is the only way to serve a theme
against a real store. In that environment those assumptions turn into concrete problems:

1. **It can hang forever.** With more than one storefront channel and no `--channelId`,
   `getChannelUrl` calls an inquirer prompt (`lib/stencil-start.js:88`). In CI there is no
   one to answer it.
2. **It leaks the storefront API token.** `?debug=context` returns the entire page context
   as JSON (`pencil-response.js:127`), and that context contains
   `settings.storefront_api.token` (read at `renderer.module.js:215`). Harmless on
   localhost; on a URL other people can reach, it hands out a credential.
3. **It writes to the theme directory at boot.** If the theme has no `stencil.conf.cjs`,
   `BuildConfigManager.initConfig()` fetches Cornerstone's default from
   raw.githubusercontent.com and writes it into the theme
   (`BuildConfigManager.js:95-101`). That fails on a read-only container filesystem and
   makes boot depend on GitHub being up.
4. **It holds stdin open.** `process.stdin.resume()` plus the `rs` handler
   (`lib/stencil-start.js:224-232`) keeps the process alive and consumes stdin for a
   feature nothing can use.
5. **It renders in dev mode.** `in_development: true` / `in_production: false` are
   hardcoded (`pencil-response.js:120`), so themes that gate behavior on those flags do
   not render the way the live store would.
6. **It drops in-flight requests on shutdown.** No `SIGTERM`/`SIGINT` handler, no
   `server.stop()`.
7. **Health probes cost store API calls.** Every path falls through to the `/{url*}`
   catch-all, which runs the full two-request stapler handshake plus a GraphQL regions
   call. A liveness probe on an interval burns real BigCommerce API budget, and reports
   the *store's* health rather than the process's.

## Goals

Add a `stencil serve` command that serves a theme against a live store with no
development machinery, suitable for non-interactive deployment.

**Non-goals**, explicitly out of scope for this change: structured/JSON logging, a metrics
endpoint, request logging, and any `--watch` escape hatch. All are plausible follow-ups
and none are needed to solve the problems above.

## Approach

A new command rather than a `--headless` flag on `start`, with the shared setup extracted
into a service class both commands use. This follows what `CONTRIBUTING.md` prescribes
("Shared logic and tasks should be moved out from the CLI-command-classes to separate
service classes") and keeps `serve` genuinely small instead of making `start` a maze of
conditionals whose port semantics shift on a flag.

Every new option defaults to today's behavior, so `start` is unchanged.

### Files

| File | Change |
|---|---|
| `bin/stencil-serve.js` | new — CLI options only |
| `lib/StencilServe.js` | new — the command class |
| `lib/StencilBootstrap.js` | new — shared setup, extracted from `StencilStart` |
| `lib/stencil-start.js` | refactor — delegates setup to the bootstrap |
| `server/index.js` | `portOffset`, `showLogo`, pass new plugin options; export `buildManifest` for testing |
| `server/index.spec.js` | new — covers the option defaults |
| `server/plugins/renderer/renderer.module.js` | forward two options to `PencilResponse` |
| `server/plugins/renderer/responses/pencil-response.js` | honor those two options |
| `server/plugins/router/router.module.js` | optional health route |
| `bin/stencil.js` | register the `serve` subcommand |
| `package.json` | `bin` entry |
| `README.md` | document the command |

### `StencilBootstrap`

Owns what both commands need and nothing either does not.

| Method | Responsibility |
|---|---|
| `readConfig()` | `StencilConfigManager.read()` |
| `resolveStoreHash(stencilConfig)` | `themeApiClient.getStoreHash` |
| `resolveChannelUrl(cfg, cliOptions, { interactive, storeHash })` | `--channelUrl` → `--channelId` → prompt **only if `interactive`** |
| `checkVersion(channelUrl)` | `themeApiClient.checkCliVersion`, returns `sslUrl` / `baseUrl` |
| `fetchStoreLocale(cfg, cliOptions, storeHash)` | `storeSettingsApiClient.getStoreSettingsLocale` |
| `prepare(cliOptions, { interactive })` | runs the sequence, returns a context object |

`interactive` is the seam. `start` passes `true` and keeps today's prompt exactly. `serve`
passes `false`: a single channel is auto-selected, and genuine ambiguity becomes an
immediate error listing the available channels and their IDs.

Dependencies are constructor-injected (`themeApiClient`, `storeSettingsApiClient`,
`stencilConfigManager`, `stencilPushUtils`, `logger`) per the project convention.

### `StencilServe.run()`

```js
this.runBasicChecks();
if (cliOptions.variation) await this._themeConfigManager.setVariationByName(cliOptions.variation);
const ctx = await this._bootstrap.prepare(cliOptions, { interactive: false });
if (cliOptions.build) await this.buildTheme(cliOptions.timeout);
this.warnIfThemeJsMissing();
this._server = await this._serverModule.create({
    dotStencilFile: ctx.stencilConfig,
    variationIndex: this._themeConfigManager.variationIndex || 0,
    useCache: cliOptions.cache,
    themePath: this._themeConfigManager.themePath,
    stencilCliVersion: PACKAGE_INFO.version,
    storeSettingsLocale: ctx.storeSettingsLocale,
    portOffset: 0,
    showLogo: false,
    debugQueriesEnabled: false,
    inDevelopment: false,
    healthCheckEnabled: true,
});
this.registerShutdownHandlers();
```

No BrowserSync, no watchers, no stdin, no proxy hop. One process on the requested port.

### Server option threading

All five default to current behavior.

| Option | Default | `serve` | Effect |
|---|---|---|---|
| `portOffset` | `1` | `0` | Hapi binds `port + offset`. `start` needs `+1` for the BrowserSync hop; `serve` binds the port directly. |
| `showLogo` | `true` | `false` | Suppresses the ASCII logo in `create()`. |
| `debugQueriesEnabled` | `true` | `false` | Disables `?debug=context` and `?debug=bar`. |
| `inDevelopment` | `true` | `false` | Sets `in_development` / `in_production` in the template context. |
| `healthCheckEnabled` | `false` | `true` | Registers `GET /_stencil/health`. |

`debugQueriesEnabled` and `inDevelopment` reach `PencilResponse` as a third constructor
argument rather than being folded into `data` — `data` is the page payload and should not
carry server configuration.

The health route is namespaced `/_stencil/` rather than `/stencil/` because the existing
`cdnAssets` route already owns `/stencil/{versionId}/{fileName*}`. Hapi sorts routes by
specificity rather than registration order, so a literal path reliably beats the
`/{url*}` catch-all with no ordering fragility.

### `--build`

Off by default. When passed, `StencilServe` constructs a `BuildConfigManager`, runs
`initConfig()`, then runs the theme's `production` task once via the existing
`_prodWorker` (`process.send('production')` → wait for `'done'`) before binding the port.

Not passing it means **no `BuildConfigManager` is constructed at all** — no GitHub fetch,
no write into the theme tree, no network dependency at boot. That is what lets `serve` run
on a read-only filesystem, so it must be enforced by test, not just by intent.

CSS needs no build step regardless: `theme-assets.module.js` compiles SCSS per request.

`_prodWorker` calls back with a bare **string** on failure (`callback('worker timed out')`),
not an `Error`. `StencilServe` normalizes that before it reaches
`printCliResultErrorAndExit`, otherwise the error output is misleading.

## Error handling

Governing principle: **fail at boot, never at first request.** A deployment that starts
and then 500s on every page is worse than one that refuses to start with a reason.

| Condition | Behavior |
|---|---|
| Multiple channels, no `--channelId` / `--channelUrl` | Throw at boot, listing channels and IDs. Never prompt. |
| Exactly one channel, none specified | Auto-select it (matches `promptUserToSelectChannel`'s own single-channel behavior). |
| Zero storefront channels | Throw with a clear message. |
| `--channelId` not found | Throw naming the bad ID. |
| `--build` fails or times out | Normalize to `Error`, exit non-zero, **never bind the port**. |
| `EADDRINUSE` | One-line message instead of a raw Hapi stack. |
| `stencil.conf.cjs` present, `assets/dist` missing, no `--build` | Warn once, keep serving. Some themes have no JS build, so this cannot be fatal. |
| `SIGTERM` / `SIGINT` | `server.stop({ timeout: 10000 })`, then exit 0. Guarded against a second signal re-entering. |
| Unhandled rejection | **Left alone deliberately.** Node's default crash is correct; an orchestrator restart is better recovery than a handler that swallows the error and leaves the process in an unknown state. |

### Bug fixed in passing

`getChannelUrl` currently does `return foundChannel ? foundChannel.url : null`
(`lib/stencil-start.js:104`). An unknown `--channelId` yields `null`, which flows into
`checkCliVersion({ storeUrl: null })` → `new URL(path, null)` → a `TypeError` about an
invalid base URL that names nothing useful. The bootstrap throws a clear error instead.

This is a deliberate, small behavior change to `start`'s error path — from a cryptic
failure to a described one. It is in scope because the refactor already moves this exact
function.

## Testing

Existing conventions: colocated `*.spec.js`, constructor-injected mocks, Jest under
`--experimental-vm-modules`.

**New**

- `lib/StencilBootstrap.spec.js` — `interactive: true` still prompts; `interactive: false`
  throws on ambiguity; single channel auto-selected; `--channelUrl` short-circuits the
  channel lookup; unknown `--channelId` produces the named error.
- `lib/StencilServe.spec.js` — the load-bearing assertions are negative: **BrowserSync is
  never constructed**, and **`BuildConfigManager` is never constructed without `--build`**.
  Plus `portOffset: 0`; `SIGTERM` triggers `server.stop`; a string-valued build failure
  surfaces as an `Error`; a failed build never reaches `create()`.

- `server/index.spec.js` — `buildManifest` defaults: port offset `1`,
  `debugQueriesEnabled` and `inDevelopment` true, `healthCheckEnabled` false; and each
  flipped when passed. This is where the "`start` is unchanged" guarantee is actually
  pinned down, which is why `buildManifest` gains a named export.

**Existing — the regression proof**

- `lib/stencil-start.spec.js` must pass **untouched** — no edits at all. This is the
  evidence the refactor preserves behavior. `getChannelUrl` is unit-tested directly at
  line 151, so it stays as a delegating method rather than being removed.
- `pencil-response.spec.js` — add cases for both new options false; assert the defaults
  still produce today's behavior.
- `router.module.spec.js` — health route present when enabled, absent when not. Needs its
  own Hapi server instance because the plugin keeps a module-level `internals.options`
  singleton.

**Manual verification** — unit tests with mocked API clients cannot prove a page renders.
Requires a real store:

1. `stencil serve --channelId <id> --port 3000` → a storefront page renders.
2. `?debug=context` returns the page, not the context JSON.
3. `?debug=bar` does not append the context blob.
4. Page source shows production-mode behavior where the theme branches on
   `in_development`.
5. `GET /_stencil/health` returns 200 without a store round-trip.
6. `SIGTERM` drains in-flight requests instead of dropping them.
7. `stencil start` still behaves exactly as before, on the same theme.
