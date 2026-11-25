import 'colors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import BuildConfigManagerClass from './BuildConfigManager.js';

const BUILD_CONFIG_FILES = ['stencil.conf.cjs', 'stencil.conf.mjs', 'stencil.conf.js'];
const hook = (name) => fileURLToPath(new URL(`./build-hooks/${name}`, import.meta.url));
// Preloaded into the build worker of preview builds; see each file for what it does.
const PREVIEW_BUILD_HOOKS = [
    hook('no-source-maps.cjs'),
    hook('uglify-cache.cjs'),
    hook('babel-cache.cjs'),
];
// Preloaded into the build worker of `stencil bundle`. Only the caches: a release keeps the
// theme's own source map setting.
const BUNDLE_BUILD_HOOKS = [hook('uglify-cache.cjs'), hook('babel-cache.cjs')];

/**
 * Where build caches live when STENCIL_BUILD_CACHE_DIR doesn't say (a developer machine or CI
 * runner without a BuildKit cache mount).
 *
 * @param {object} [env]
 * @returns {string}
 */
const defaultBuildCacheDir = (env = process.env) =>
    env.STENCIL_BUILD_CACHE_DIR ||
    path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'stencil-cli', 'build');

/**
 * @param {string} themePath
 * @param {object} [fsModule]
 * @returns {boolean} whether the theme ships a build config (stencil.conf.*)
 */
const hasBuildConfig = (themePath, fsModule = fs) =>
    BUILD_CONFIG_FILES.some((name) => fsModule.existsSync(path.join(themePath, name)));

/**
 * Runs the theme's production build task (stencil.conf.* `production`), which writes the
 * theme JavaScript to assets/dist.
 *
 * Only call this for a theme that has a build config: constructing the config manager for one
 * without downloads Cornerstone's stencil.conf.cjs into the theme.
 *
 * @param {object} [options]
 * @param {number} [options.timeout] - seconds to wait for the build worker to start
 * @param {Function} [options.BuildConfigManager]
 * @param {object} [options.logger]
 * @param {boolean} [options.preview] - build for a preview image: without webpack source maps
 *   (producing them slows the minifier, and nobody debugs a preview with them), and with
 *   webpack 3's minifier cached and run in parallel. The JavaScript itself is the same.
 * @returns {Promise<void>}
 */
const buildThemeAssets = async ({
    timeout = 60,
    BuildConfigManager = BuildConfigManagerClass,
    logger = console,
    preview = false,
} = {}) => {
    const buildConfigManager = new BuildConfigManager({
        timeout: timeout * 1000,
        workerPreload: preview ? PREVIEW_BUILD_HOOKS : [],
    });
    await buildConfigManager.initConfig();
    if (typeof buildConfigManager.production !== 'function') {
        throw new Error('This theme has no production build task.'.red);
    }
    logger.log('Building theme assets...');
    await new Promise((resolve, reject) => {
        buildConfigManager.initWorker().production((err) => {
            if (err) {
                // _prodWorker reports failures as plain strings ('worker timed out'),
                // so normalise before this reaches the CLI error printer.
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            resolve();
        });
    });
    logger.log(`${'ok'.green} -- theme assets built`);
};

export { hasBuildConfig, buildThemeAssets, BUNDLE_BUILD_HOOKS, defaultBuildCacheDir };
