import 'colors';
import fsModule from 'fs';
import path from 'path';
import inquirerModule from 'inquirer';
import * as nypmModule from 'nypm';
import spinnerModule from './spinner.js';
import * as serverConfigModule from '../server/config.js';
import StencilConfigManager from './StencilConfigManager.js';
import { buildThemeAssets, hasBuildConfig } from './theme-build.js';
import { hashBuildInputs, restoreBuild, saveBuild } from './theme-build-cache.js';
import { DEFAULT_CUSTOM_LAYOUTS_CONFIG, API_HOST, THEME_PATH } from '../constants.js';

// Seconds the build worker gets to start, unless STENCIL_BUILD_TIMEOUT says otherwise.
const DEFAULT_PREBUILD_TIMEOUT = 900;

class StencilInit {
    /**
     * @param inquirer
     * @param stencilConfigManager
     * @param serverConfig
     * @param logger
     * @param nypm
     * @param spinner
     * @param env - environment variables; STENCIL_INIT_BUILD=1 turns on the theme build,
     *   STENCIL_BUILD_CACHE_DIR points at a directory that persists between image builds
     * @param fs
     * @param buildTheme
     */
    constructor({
        inquirer = inquirerModule,
        stencilConfigManager = new StencilConfigManager(),
        serverConfig = serverConfigModule,
        logger = console,
        nypm = nypmModule,
        spinner = spinnerModule,
        env = process.env,
        fs = fsModule,
        buildTheme = buildThemeAssets,
    } = {}) {
        this._inquirer = inquirer;
        this._stencilConfigManager = stencilConfigManager;
        this._serverConfig = serverConfig;
        this._logger = logger;
        this._nypm = nypm;
        this._spinner = spinner;
        this._env = env;
        this._fs = fs;
        this._buildTheme = buildTheme;
    }

    /**
     * @param {object} cliOptions
     * @param {string} cliOptions.normalStoreUrl
     * @param {string} cliOptions.accessToken
     * @param {number} cliOptions.port
     * @returns {Promise<void>}
     */
    async run(cliOptions = {}) {
        const oldStencilConfig = await this.readStencilConfig();
        const defaultAnswers = this.getDefaultAnswers(oldStencilConfig);
        const questions = this.getQuestions(defaultAnswers, cliOptions);
        const answers = await this.askQuestions(questions);
        const updatedStencilConfig = this.applyAnswers(oldStencilConfig, answers, cliOptions);
        await this._stencilConfigManager.save(updatedStencilConfig);
        await this.installDependencies(THEME_PATH, answers.packageManager, cliOptions);
        await this.prebuildThemeAssets(THEME_PATH);
        this._logger.log(
            'You are now ready to go! To start developing, run $ ' + 'stencil start'.cyan,
        );
    }

    /**
     * Builds the theme JavaScript (assets/dist) when STENCIL_INIT_BUILD=1.
     *
     * For container images: `stencil init` runs during the image build, after the theme is
     * copied in, so building here bakes assets/dist into the image instead of every container
     * building it on boot (`stencil serve --build`). Off by default so a developer's
     * `stencil init` stays quick.
     *
     * Skipped when the theme has no build config or assets/dist already exists (an earlier
     * build step made it). A failed build is reported and its partial output removed, but does
     * not fail init: the container then builds on boot, exactly as it would without this.
     *
     * With STENCIL_BUILD_CACHE_DIR set to an existing directory (a BuildKit cache mount, which
     * outlives the image build), builds are stored there keyed by a hash of the JavaScript
     * inputs. A theme whose JavaScript inputs match a previous build gets that build copied in
     * instead of running webpack, which is most pull requests: they change templates or styles.
     * The directory must already exist, so without the mount nothing is written into the image.
     *
     * @param {string} themePath
     * @returns {Promise<void>}
     */
    async prebuildThemeAssets(themePath) {
        if (this._env.STENCIL_INIT_BUILD !== '1') {
            return;
        }
        if (!hasBuildConfig(themePath, this._fs)) {
            this._logger.log('STENCIL_INIT_BUILD: the theme has no build config, nothing to build');
            return;
        }
        const distPath = path.join(themePath, 'assets/dist');
        if (this._fs.existsSync(distPath)) {
            this._logger.log('STENCIL_INIT_BUILD: assets/dist already exists, not rebuilding');
            return;
        }
        const cacheDir = this._env.STENCIL_BUILD_CACHE_DIR;
        const useCache = Boolean(cacheDir) && this._fs.existsSync(cacheDir);
        // Preview images are built without source maps (see prebuildThemeAssets).
        const cacheKey = useCache ? hashBuildInputs(themePath, 'no-source-maps') : null;
        if (useCache && this.restoreFromBuildCache(cacheDir, cacheKey, distPath)) {
            this._logger.log(
                `${'ok'.green} -- theme assets restored from the build cache (${cacheKey.slice(
                    0,
                    12,
                )}); no JavaScript inputs changed`,
            );
            return;
        }
        const timeout = parseInt(this._env.STENCIL_BUILD_TIMEOUT, 10) || DEFAULT_PREBUILD_TIMEOUT;
        try {
            await this._buildTheme({ timeout, logger: this._logger, sourceMaps: false });
        } catch (err) {
            this._fs.rmSync(distPath, { recursive: true, force: true });
            this._logger.error(
                `${'Warning'.yellow}: STENCIL_INIT_BUILD: the theme build failed (${
                    err.message
                }). It will be built when the server starts instead.`,
            );
            return;
        }
        if (useCache) {
            try {
                saveBuild(cacheDir, cacheKey, distPath);
                this._logger.log(
                    `theme assets saved to the build cache (${cacheKey.slice(0, 12)})`,
                );
            } catch (err) {
                // The build itself succeeded; a cache that cannot be written only costs speed.
                this._logger.error(
                    `Could not save the theme assets to the build cache: ${err.message}`,
                );
            }
        }
    }

    /**
     * @param {string} cacheDir
     * @param {string} cacheKey
     * @param {string} distPath
     * @returns {boolean} whether assets/dist now holds the cached build
     */
    restoreFromBuildCache(cacheDir, cacheKey, distPath) {
        try {
            return restoreBuild(cacheDir, cacheKey, distPath);
        } catch (err) {
            // A broken entry must not leave half a build behind; build from scratch instead.
            this._fs.rmSync(distPath, { recursive: true, force: true });
            this._logger.error(`Could not restore from the build cache: ${err.message}`);
            return false;
        }
    }

    /**
     * @returns {object}
     */
    async readStencilConfig() {
        let parsedConfig;
        try {
            parsedConfig = await this._stencilConfigManager.read(true, true);
        } catch (err) {
            this._logger.error(
                'Detected a broken stencil-cli config:\n',
                err,
                '\nThe file will be rewritten with your answers',
            );
        }
        return parsedConfig || {};
    }

    /**
     * @param {{port: (number), normalStoreUrl: (string), accessToken: (string), apiHost: (string)}} stencilConfig
     * @returns {{port: (number), normalStoreUrl: (string), accessToken: (string), apiHost: (string)}}
     */
    getDefaultAnswers(stencilConfig) {
        return {
            normalStoreUrl: stencilConfig.normalStoreUrl,
            accessToken: stencilConfig.accessToken,
            port: stencilConfig.port || this._serverConfig.get('/server/port'),
            apiHost: API_HOST,
        };
    }

    /**
     * @param {{port: (number), normalStoreUrl: (string), accessToken: (string)}} defaultAnswers
     * @param {{port: (number), normalStoreUrl: (string), accessToken: (string)}} cliOptions
     * @returns {{object[]}}
     */
    getQuestions(defaultAnswers, cliOptions) {
        const prompts = [];
        if (!cliOptions.normalStoreUrl) {
            prompts.push({
                type: 'input',
                name: 'normalStoreUrl',
                message: "What is the URL of your store's home page?",
                validate: (val) => /^https?:\/\//.test(val) || 'You must enter a URL',
                default: defaultAnswers.normalStoreUrl,
            });
        }
        if (!cliOptions.accessToken) {
            prompts.push({
                type: 'input',
                name: 'accessToken',
                message: 'What is your Stencil OAuth Access Token?',
                default: defaultAnswers.accessToken,
                filter: (val) => val.trim(),
            });
        }
        if (!cliOptions.port) {
            prompts.push({
                type: 'input',
                name: 'port',
                message: 'What port would you like to run the server on?',
                default: defaultAnswers.port,
                validate: (val) => {
                    if (Number.isNaN(val)) {
                        return 'You must enter an integer';
                    }
                    if (val < 1024 || val > 65535) {
                        return 'The port number must be between 1025 and 65535';
                    }
                    return true;
                },
            });
        }
        if (!cliOptions.packageManager) {
            prompts.push({
                type: 'list',
                name: 'packageManager',
                message: 'What is your favourite Package Manager?',
                choices: ['npm', 'yarn', 'pnpm'],
                default: this.getPackageManager(),
            });
        }
        return prompts;
    }

    /**
     * @param {{object[]}} questions
     * @returns {Promise<object>}
     */
    async askQuestions(questions) {
        return questions.length ? this._inquirer.prompt(questions) : {};
    }

    updateApiHost(stencilConfig, cliOptions) {
        const host = cliOptions.apiHost || API_HOST;
        console.log('Set API host to: ' + host);
        return { ...stencilConfig, apiHost: host };
    }

    /**
     * @param {object} stencilConfig
     * @param {object} answers
     * @param {object} cliOptions
     * @returns {object}
     */
    applyAnswers(stencilConfig, answers, cliOptions) {
        const config = this.updateApiHost(stencilConfig, cliOptions);
        return {
            customLayouts: DEFAULT_CUSTOM_LAYOUTS_CONFIG,
            ...config,
            ...cliOptions,
            ...answers,
        };
    }

    getPackageManager() {
        const userAgent = process.env.npm_config_user_agent || '';
        if (userAgent.startsWith('yarn')) {
            return 'yarn';
        }
        if (userAgent.startsWith('pnpm')) {
            return 'pnpm';
        }
        return 'npm';
    }

    /**
     *
     * @param {string} projectDir
     * @param {object} packageManager
     * @param {object} cliOptions
     * @returns
     */
    installDependencies(projectDir, packageManager, cliOptions) {
        if (cliOptions.skipInstall) {
            return Promise.resolve();
        }
        return this._spinner(
            this._nypm.installDependencies({
                cwd: projectDir,
                silent: true,
                packageManager,
            }),
            {
                text: `Installing dependencies. This could take a minute...`,
                successText: `Dependencies installed successfully`,
                failText: (err) => `Failed to install dependencies: ${err.message}`.red,
            },
        );
    }
}
export default StencilInit;
