import { defaultsDeep } from 'lodash-es';
import * as Boom from '@hapi/boom';
import { fork } from 'child_process';
import Crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import zlib from 'zlib';
import { uuidRegExp, uuid2int } from '../../lib/utils.js';
import ThemeConfig from '../../../lib/theme-config.js';
import { listStylesheets, loadPrecompiled } from '../../../lib/css-precompile.js';

const gzip = promisify(zlib.gzip);
const CSS_WORKER_PATH = fileURLToPath(new URL('./css-compile-worker.js', import.meta.url));

const internals = {
    options: {},
    // `${variationIndex}\0${fileName}` -> Promise<{css, gzipped, etag}>, only for an immutable theme
    cssCache: null,
    // Stylesheets waiting for the next compile worker: [{ job, resolve, reject }]
    cssQueue: [],
    cssWorkerRunning: false,
    cssReady: true,
};
function register(server, options) {
    // Read before defaultsDeep, which back-fills options from a previous registration.
    const immutableTheme = options.immutableTheme === true;
    internals.options = defaultsDeep(options, internals.options);
    internals.cssCache = immutableTheme ? new Map() : null;
    // An immutable theme is ready once warmCssCache has filled the cache; otherwise
    // stylesheets compile per request and there is nothing to wait for.
    internals.cssReady = !immutableTheme;
    server.expose('cssHandler', internals.cssHandler);
    server.expose('assetHandler', internals.assetHandler);
    server.expose('warmCssCache', internals.warmCssCache);
    server.expose('isReady', () => internals.cssReady);
}
/**
 * Get the variation index from the "ConfigId" in the css filename
 * @param  {string} fileName
 * @returns {number}
 */
internals.getVariationIndex = (fileName) => {
    const match = fileName.match(new RegExp(`.+-(${uuidRegExp})$`));
    return match ? uuid2int(match[1]) - 1 : 0;
};
/**
 * Get the original css file name
 * @param  {string} fileName
 * @returns {string}
 */
internals.getOriginalFileName = (fileName) => {
    const match = fileName.match(new RegExp(`(.+)-${uuidRegExp}$`));
    return match ? match[1] : fileName;
};
/**
 * CSS Compiler Handler.  This utilises the CSS Assembler to gather all of the CSS files and then the
 * StencilStyles plugin to compile them all.
 * @param request
 * @param h
 */
internals.cssHandler = async (request, h) => {
    const variationIndex = internals.getVariationIndex(request.params.fileName);
    const variationExists = await request.app.themeConfig.variationExists(variationIndex);
    if (!variationExists) {
        throw Boom.notFound(`Variation ${variationIndex + 1} does not exist.`);
    }
    const fileName = internals.getOriginalFileName(request.params.fileName);
    if (internals.cssCache) {
        let compiled;
        try {
            compiled = await internals.getCachedCss(variationIndex, fileName);
        } catch (err) {
            console.error(err);
            throw Boom.badData(err);
        }
        // Theme stylesheets run to megabytes. Hapi would gzip them again on every request,
        // so the copy compressed once at compile time is sent when the client accepts it.
        // The ETag lets browsers revalidate with a 304 instead of downloading the file again.
        const response =
            request.info.acceptEncoding === 'gzip'
                ? h
                      .response(compiled.gzipped)
                      .header('content-encoding', 'gzip')
                      .etag(`${compiled.etag}-gzip`, { vary: false })
                : h.response(compiled.css).etag(compiled.etag, { vary: false });
        return response.type('text/css').vary('accept-encoding');
    }
    // Set the variation to get the right theme configuration
    request.app.themeConfig.setVariation(variationIndex);
    // Get the theme configuration
    const configuration = await request.app.themeConfig.getConfig();
    const themeAssetsPath = internals.getThemeAssetsPath();
    // Loaded on first use: `stencil serve` compiles in a worker and never needs it here.
    // eslint-disable-next-line node/no-unsupported-features/es-syntax
    const { default: cssCompiler } = await import('../../../lib/css/compile.js');
    try {
        const css = await cssCompiler.compile(configuration, themeAssetsPath, fileName);
        return h.response(css).type('text/css');
    } catch (err) {
        console.error(err);
        throw Boom.badData(err);
    }
};
/**
 * Queues a stylesheet for compilation in a child process (css-compile-worker.js). One worker
 * runs at a time and takes every stylesheet queued when it starts, so a burst of requests
 * costs one process start and never several compiles competing for the CPU.
 *
 * @param {number} variationIndex
 * @param {string} fileName
 * @returns {Promise<string>} the compiled CSS
 */
internals.compileInWorker = (variationIndex, fileName) =>
    new Promise((resolve, reject) => {
        internals.cssQueue.push({ job: { variationIndex, fileName }, resolve, reject });
        // Next tick, so every stylesheet requested in this turn joins the same worker.
        setImmediate(internals.runCssWorker);
    });
internals.runCssWorker = () => {
    if (internals.cssWorkerRunning || internals.cssQueue.length === 0) {
        return;
    }
    internals.cssWorkerRunning = true;
    const batch = internals.cssQueue.splice(0);
    const settled = new Set();
    const worker = fork(CSS_WORKER_PATH, [], { serialization: 'advanced' });
    worker.on('message', ({ index, css, error }) => {
        settled.add(index);
        if (error === undefined) {
            batch[index].resolve(css);
        } else {
            batch[index].reject(new Error(error));
        }
    });
    const finish = (reason) => {
        batch.forEach((entry, index) => {
            if (!settled.has(index)) {
                settled.add(index);
                entry.reject(new Error(`The stylesheet compiler ${reason}`));
            }
        });
        internals.cssWorkerRunning = false;
        internals.runCssWorker();
    };
    worker.once('exit', (code, signal) => finish(`exited (${signal || code})`));
    worker.once('error', (err) => {
        finish(`failed to start: ${err.message}`);
        worker.removeAllListeners('exit');
    });
    worker.send({ themePath: internals.options.themePath, jobs: batch.map(({ job }) => job) });
};
/**
 * Compiles a stylesheet of an immutable theme once per variation; concurrent requests for the
 * same file share one compilation. Compilation runs in a child process, which also keeps a
 * stylesheet request from switching the variation pages render with.
 *
 * @param {number} variationIndex
 * @param {string} fileName - stylesheet name without extension or config id
 * @returns {Promise<{css: string, gzipped: Buffer, etag: string}>}
 */
internals.getCachedCss = (variationIndex, fileName) => {
    const key = `${variationIndex}\0${fileName}`;
    let promise = internals.cssCache.get(key);
    if (!promise) {
        promise = internals
            .compileInWorker(variationIndex, fileName)
            .then((css) => internals.cacheCompiledCss(css));
        internals.cssCache.set(key, promise);
        // A failed compile is not cached, so the next request reports the error again.
        promise.catch(() => internals.cssCache.delete(key));
    }
    return promise;
};
/**
 * @param {string} css
 * @returns {Promise<{css: string, gzipped: Buffer, etag: string}>}
 */
internals.cacheCompiledCss = async (css) => {
    const etag = Crypto.createHash('sha1').update(css).digest('hex');
    return { css, gzipped: await gzip(css), etag };
};
/**
 * Fills the stylesheet cache of an immutable theme for one variation, so the first visitor does
 * not wait for SCSS compilation: from the stylesheets the image build precompiled when they
 * match this theme exactly (lib/css-precompile.js), otherwise by compiling every top-level
 * stylesheet in a single worker. Failures are reported per file. Until this settles, isReady()
 * is false, which the health route reports so a deployment keeps the previous container
 * serving meanwhile.
 *
 * @param {number} variationIndex
 * @param {object} [logger]
 * @returns {Promise<{compiled: string[], failed: string[], precompiled: boolean}>}
 */
internals.warmCssCache = async (variationIndex = 0, logger = console) => {
    if (!internals.cssCache) {
        return { compiled: [], failed: [], precompiled: false };
    }
    try {
        return await internals.fillCssCache(variationIndex, logger);
    } finally {
        internals.cssReady = true;
    }
};
internals.fillCssCache = async (variationIndex, logger) => {
    const { themePath } = internals.options;
    let precompiled = null;
    try {
        precompiled = await loadPrecompiled(themePath, variationIndex);
    } catch (err) {
        logger.error(`Could not read the precompiled stylesheets: ${err.message}`);
    }
    if (precompiled) {
        const loaded = [...precompiled.entries()].map(([fileName, css]) => {
            const promise = internals.cacheCompiledCss(css);
            internals.cssCache.set(`${variationIndex}\0${fileName}`, promise);
            return promise;
        });
        await Promise.all(loaded);
        return { compiled: [...precompiled.keys()], failed: [], precompiled: true };
    }
    const themeConfig = ThemeConfig.create(themePath);
    const { css_compiler: cssCompilerName } = await themeConfig.getRawConfig();
    const { ext, fileNames } = listStylesheets(themePath, cssCompilerName);
    const results = await Promise.allSettled(
        // All queued before the worker starts, so one worker compiles them all.
        fileNames.map((fileName) => internals.getCachedCss(variationIndex, fileName)),
    );
    const compiled = [];
    const failed = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            compiled.push(fileNames[index]);
        } else {
            failed.push(fileNames[index]);
            logger.error(
                `Could not precompile ${fileNames[index]}.${ext}: ${result.reason.message}`,
            );
        }
    });
    return { compiled, failed, precompiled: false };
};
/**
 * Assets handler
 *
 * @param request
 * @param h
 */
internals.assetHandler = (request, h) => {
    const filePath = path.join(internals.getThemeAssetsPath(), request.params.fileName);
    return h.file(filePath);
};
internals.getThemeAssetsPath = () => {
    return path.join(internals.options.themePath, 'assets');
};
export const name = 'ThemeAssets';
export const version = '0.0.1';
export { register };
export default {
    register,
    name,
    version,
};
