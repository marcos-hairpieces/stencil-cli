import 'colors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import BuildConfigManagerClass from './BuildConfigManager.js';

const BUILD_CONFIG_FILES = ['stencil.conf.cjs', 'stencil.conf.mjs', 'stencil.conf.js'];
const NO_SOURCE_MAPS_HOOK = fileURLToPath(
    new URL('./build-hooks/no-source-maps.cjs', import.meta.url),
);

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
 * @param {boolean} [options.sourceMaps] - false builds without webpack source maps (preview
 *   images: producing them slows the minifier, and nobody debugs a preview with them)
 * @returns {Promise<void>}
 */
const buildThemeAssets = async ({
    timeout = 60,
    BuildConfigManager = BuildConfigManagerClass,
    logger = console,
    sourceMaps = true,
} = {}) => {
    const buildConfigManager = new BuildConfigManager({
        timeout: timeout * 1000,
        workerPreload: sourceMaps ? [] : [NO_SOURCE_MAPS_HOOK],
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

export { hasBuildConfig, buildThemeAssets };
