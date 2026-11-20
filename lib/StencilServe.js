import 'colors';
import path from 'path';
import Server from '../server/index.js';
import StencilBootstrap from './StencilBootstrap.js';
import ThemeConfig from './theme-config.js';
import BuildConfigManagerClass from './BuildConfigManager.js';
import fsUtilsModule from './utils/fsUtils.js';
import cliCommonModule from './cliCommon.js';
import { buildThemeAssets, hasBuildConfig } from './theme-build.js';
import { PACKAGE_INFO, THEME_PATH } from '../constants.js';

const SHUTDOWN_TIMEOUT = 10000;
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

/**
 * Serves a theme against a live store without any development machinery.
 *
 * Where `stencil start` layers BrowserSync, filesystem watchers, an interactive channel
 * prompt and dev-only debug output on top of the local server, this command runs the
 * server alone. It is meant for preview and staging deployments: non-interactive,
 * container-friendly, and it never writes to the theme directory.
 */
class StencilServe {
    constructor({
        bootstrap = new StencilBootstrap(),
        themeConfigManager = ThemeConfig.getInstance(THEME_PATH),
        BuildConfigManager = BuildConfigManagerClass,
        serverModule = Server,
        fsUtils = fsUtilsModule,
        cliCommon = cliCommonModule,
        logger = console,
        processRef = process,
    } = {}) {
        this._bootstrap = bootstrap;
        this._themeConfigManager = themeConfigManager;
        this._BuildConfigManager = BuildConfigManager;
        this._serverModule = serverModule;
        this._fsUtils = fsUtils;
        this._cliCommon = cliCommon;
        this._logger = logger;
        this._process = processRef;
        this._server = null;
        this._shuttingDown = false;
    }

    /**
     * @param {Object} cliOptions
     */
    async run(cliOptions) {
        this.runBasicChecks(cliOptions);
        if (cliOptions.variation) {
            await this._themeConfigManager.setVariationByName(cliOptions.variation);
        }
        const context = await this._bootstrap.prepare(cliOptions, { interactive: false });
        // Only touch the build config when a build was actually asked for. Constructing a
        // BuildConfigManager downloads Cornerstone's stencil.conf.cjs from GitHub and writes
        // it into the theme when the theme has none, which would break a read-only deployment.
        if (cliOptions.build) {
            await this.buildTheme(cliOptions.timeout);
        }
        this.warnIfThemeJsMissing();
        this._server = await this.startLocalServer(cliOptions, context);
        this.registerShutdownHandlers();
        this._logger.log(this.getStartUpInfo(context));
        this.warmCssCache();
        return this._server;
    }

    /**
     * @param {Object} cliOptions
     */
    runBasicChecks(cliOptions) {
        this._cliCommon.checkNodeVersion();
        if (!this._fsUtils.existsSync(this._themeConfigManager.configPath)) {
            throw new Error(
                'You must have a '.red +
                    ' config.json '.cyan +
                    'file in your top level theme directory.',
            );
        }
        // If the value is true it means that no variation name was passed in.
        if (cliOptions.variation === true) {
            throw new Error('You have to specify a value for -v or --variation'.red);
        }
    }

    /**
     * Runs the theme's production build task once, before the server binds a port.
     *
     * @param {number} [timeout] - seconds
     */
    async buildTheme(timeout) {
        await buildThemeAssets({
            timeout: timeout || 60,
            BuildConfigManager: this._BuildConfigManager,
            logger: this._logger,
        });
    }

    /**
     * Themes with a build config are expected to emit assets/dist. Serving without them
     * yields a page with missing JavaScript, which is worth naming at boot rather than
     * leaving to be discovered in a browser console. Not fatal: plenty of themes ship no JS.
     */
    warnIfThemeJsMissing() {
        const { themePath } = this._themeConfigManager;
        if (
            hasBuildConfig(themePath, this._fsUtils) &&
            !this._fsUtils.existsSync(path.join(themePath, 'assets/dist'))
        ) {
            this._logger.log(
                `${'Warning'.yellow}: this theme has a build config but no ${
                    'assets/dist'.cyan
                }. ` +
                    `Theme JavaScript may be missing. Build it first, or pass ${'--build'.cyan}.`,
            );
        }
    }

    /**
     * @param {Object} cliOptions
     * @param {Object} context
     * @return {Promise<any>}
     */
    async startLocalServer(cliOptions, context) {
        try {
            return await this._serverModule.create({
                dotStencilFile: context.stencilConfig,
                variationIndex: this._themeConfigManager.variationIndex || 0,
                useCache: cliOptions.cache,
                themePath: this._themeConfigManager.themePath,
                stencilCliVersion: PACKAGE_INFO.version,
                storeSettingsLocale: context.storeSettingsLocale,
                // Bind the requested port directly. `start` offsets by one because
                // BrowserSync owns the user-facing port and proxies to Hapi.
                portOffset: 0,
                // All interfaces unless told otherwise: a deployment is reached through a
                // port mapping or a proxy, never from the loopback interface alone.
                host: cliOptions.bind || '0.0.0.0',
                showLogo: false,
                // Dev-only affordances, off for a deployment. ?debug=context returns the whole
                // page context, which includes settings.storefront_api.token.
                debugQueriesEnabled: false,
                inDevelopment: false,
                healthCheckEnabled: true,
                // The theme directory is fixed for the life of the process, so templates and
                // stylesheets are compiled once and served from memory.
                immutableTheme: true,
                // Seconds on the command line, milliseconds inside the server. Left out
                // entirely when not given so the renderer keeps its own default.
                ...(cliOptions.cacheTtl ? { cacheTTL: cliOptions.cacheTtl * 1000 } : {}),
            });
        } catch (error) {
            if (error && error.code === 'EADDRINUSE') {
                throw new Error(
                    `Port ${String(context.port).cyan} is already in use. `.red +
                        'Stop whatever is listening on it, or pass a different --port.'.red,
                );
            }
            throw error;
        }
    }

    /**
     * Compiles the theme's stylesheets in the background once the server is listening. SCSS
     * compilation takes seconds per file, and without this the first page view pays for it.
     * Requests that arrive meanwhile wait on the same compilation instead of starting another.
     */
    warmCssCache() {
        const themeAssets = this._server.plugins && this._server.plugins.ThemeAssets;
        if (!themeAssets || typeof themeAssets.warmCssCache !== 'function') {
            return;
        }
        // Monotonic: the wall clock can jump (NTP, WSL resync) while this runs.
        const startedAt = performance.now();
        themeAssets
            .warmCssCache(this._themeConfigManager.variationIndex || 0, this._logger)
            .then(({ compiled }) => {
                if (compiled.length > 0) {
                    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
                    this._logger.log(
                        `${'ok'.green} -- ${
                            compiled.length
                        } stylesheet(s) precompiled in ${seconds}s`,
                    );
                }
            })
            .catch((error) => this._logger.error(error));
    }

    registerShutdownHandlers() {
        for (const signal of SHUTDOWN_SIGNALS) {
            this._process.on(signal, () => {
                this.shutdown(signal);
            });
        }
    }

    /**
     * Drains in-flight requests before exiting. Re-entrant calls are ignored so a second
     * signal during shutdown doesn't start a second stop.
     *
     * @param {string} signal
     */
    async shutdown(signal) {
        if (this._shuttingDown) {
            return;
        }
        this._shuttingDown = true;
        this._logger.log(`\nReceived ${signal}, shutting down...`);
        try {
            if (this._server) {
                await this._server.stop({ timeout: SHUTDOWN_TIMEOUT });
            }
            this._process.exit(0);
        } catch (error) {
            this._logger.error(error);
            this._process.exit(1);
        }
    }

    /**
     * @param {Object} context
     * @returns {string}
     */
    getStartUpInfo(context) {
        return (
            `stencil serve listening on ${`http://localhost:${context.port}`.cyan} ` +
            `-> ${context.stencilConfig.normalStoreUrl.cyan} ` +
            `(stencil-cli ${PACKAGE_INFO.version}, node ${process.version})`
        );
    }
}
export default StencilServe;
