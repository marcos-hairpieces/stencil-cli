/**
 * Preloaded (`node --require`) into the theme build worker for preview builds. Speeds up
 * webpack 3's built-in minifier (`webpack.optimize.UglifyJsPlugin`, which is
 * uglifyjs-webpack-plugin 0.4.x) without touching the theme's build configuration:
 *
 * - Every file the plugin would minify is looked up in a cache under
 *   $STENCIL_BUILD_CACHE_DIR/uglify-js, keyed by its source, the plugin and uglify-js versions
 *   and the plugin options. webpack 3 renders unchanged chunks byte for byte the same, so a
 *   pull request that changes one page script only has to minify that page's chunk.
 * - The files that are not cached are minified in parallel worker threads, each running the
 *   theme's own plugin code with the same options on that one file, so the output is exactly
 *   what the plugin would have produced.
 *
 * The results are handed to the theme's plugin through the marker it keeps on each asset for
 * watch rebuilds (`asset.__UglifyJsPlugin`): it then uses them instead of minifying again. Any
 * file this hook could not produce, for whatever reason, is left to the plugin, which minifies
 * it in the build process exactly as it would without this hook. So a problem here can only
 * cost time, never fail or change the build.
 *
 * Without the cache directory (no BuildKit cache mount) files are still minified in parallel,
 * and nothing is written. Other webpack versions and other minifiers are left alone.
 */
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_SCRIPT = path.join(__dirname, 'uglify-worker.cjs');
// The webpack 3 module behind `webpack.optimize.UglifyJsPlugin`; it re-exports the plugin.
const WEBPACK3_PLUGIN_MODULE = path.join('webpack', 'lib', 'optimize', 'UglifyJsPlugin.js');
const SUPPORTED_PLUGIN_VERSION = /^0\.4\./;
// Bump when the cache entry format or the way entries are produced changes.
const CACHE_FORMAT = 1;
const CACHE_SUBDIR = 'uglify-js';
// Oldest entries beyond this total size are removed after each build. A full CA build is
// about 6 MB of minified JavaScript (plus the plugin's warnings), so this keeps dozens.
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
// Temporary files older than this were left by a build that died while writing.
const STALE_TMP_MS = 60 * 60 * 1000;
// Memory allowed per worker, to bound the worker count on small machines. A worker minifying
// CA's 4 MB main bundle peaks at about 400 MB, next to the ~1 GB the webpack build itself
// holds, so this leaves room for both.
const WORKER_MEMORY_BYTES = 1024 * 1024 * 1024;

const log = (message) => console.log(`minify cache: ${message}`);

/**
 * Options the cache can key on and a worker can receive: plain data (regular expressions
 * included), without the features that give one file's result a dependency on another file
 * or produce more than the minified file (source maps, extracted comments, property mangling
 * with its shared name cache).
 *
 * @param {object} options
 * @returns {string|null} a stable serialisation, or null when unsupported
 */
const serialiseOptions = (options) => {
    if (options.sourceMap || options.extractComments || (options.mangle && options.mangle.props)) {
        return null;
    }
    const serialise = (value) => {
        if (value instanceof RegExp) {
            return { regexp: String(value) };
        }
        if (Array.isArray(value)) {
            return value.map(serialise);
        }
        if (value && typeof value === 'object') {
            if (Object.getPrototypeOf(value) !== Object.prototype) {
                throw new Error('not plain data');
            }
            return Object.keys(value)
                .sort()
                .map((key) => [key, serialise(value[key])]);
        }
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
            throw new Error('not plain data');
        }
        return value;
    };
    try {
        return JSON.stringify(serialise(options));
    } catch (err) {
        return null;
    }
};

const readPackageVersion = (requireFrom, name) => requireFrom(`${name}/package.json`).version;

/**
 * @param {string} baseDir - $STENCIL_BUILD_CACHE_DIR
 * @returns {string|null} the minify cache directory, when the build cache is mounted
 */
const getCacheDir = (baseDir) => {
    if (!baseDir || !fs.existsSync(baseDir)) {
        return null;
    }
    const dir = path.join(baseDir, CACHE_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const readEntry = (cacheDir, key) => {
    const file = path.join(cacheDir, `${key}.json`);
    let entry;
    try {
        entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return null;
    }
    if (typeof entry.code !== 'string' || !Array.isArray(entry.warnings)) {
        return null;
    }
    try {
        // Recency for pruning.
        const now = new Date();
        fs.utimesSync(file, now, now);
    } catch (err) {
        // Only affects which entries are pruned first.
    }
    return entry;
};

// Written under a temporary name and renamed into place, so a build running at the same time
// never reads half an entry. Two builds writing the same key write the same content.
const writeEntry = (cacheDir, key, entry) => {
    const file = path.join(cacheDir, `${key}.json`);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(entry));
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
};

const pruneCache = (cacheDir) => {
    const now = Date.now();
    const entries = [];
    for (const name of fs.readdirSync(cacheDir)) {
        const file = path.join(cacheDir, name);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (err) {
            continue; // removed by a concurrent prune
        }
        if (name.includes('.tmp-')) {
            if (now - stat.mtimeMs > STALE_TMP_MS) {
                fs.rmSync(file, { force: true });
            }
        } else if (name.endsWith('.json')) {
            entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
        }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const entry of entries) {
        total += entry.size;
        if (total > MAX_CACHE_BYTES) {
            fs.rmSync(entry.file, { force: true });
        }
    }
};

const getWorkerCount = (jobCount) => {
    // The container's memory limit, when it has one (0 or a huge number when it does not).
    const limit = process.constrainedMemory() || Infinity;
    const memory = Math.min(os.totalmem(), limit);
    const byMemory = Math.max(1, Math.floor(memory / WORKER_MEMORY_BYTES));
    return Math.max(1, Math.min(jobCount, os.availableParallelism(), byMemory));
};

/**
 * Sends one file to a worker.
 *
 * @returns {Promise<{code: string, warnings: string[]}|null>} null when the plugin reported an
 *   error for the file; rejects when the worker died
 */
const minifyInWorker = (worker, job) =>
    new Promise((resolve, reject) => {
        const outcomes = {
            message: resolve,
            error: reject,
            exit: (code) => reject(new Error(`minify worker exited with code ${code}`)),
        };
        const listeners = {};
        Object.entries(outcomes).forEach(([event, settle]) => {
            listeners[event] = (value) => {
                Object.entries(listeners).forEach(([name, listener]) => worker.off(name, listener));
                settle(value);
            };
            worker.on(event, listeners[event]);
        });
        worker.postMessage({ file: job.file, input: job.input });
    });

/**
 * Minifies the jobs on a pool of worker threads, largest file first so the longest one starts
 * right away. A worker that dies takes only its current file with it; files no worker
 * finished are missing from the result and left to the plugin.
 *
 * @returns {Promise<Map<string, {code: string, warnings: string[]}>>} by file name
 */
const minifyAll = async (jobs, workerData) => {
    const queue = [...jobs].sort((a, b) => b.input.length - a.input.length);
    const results = new Map();
    const runWorker = async () => {
        const worker = new Worker(WORKER_SCRIPT, { workerData, execArgv: [] });
        try {
            while (queue.length > 0) {
                const job = queue.shift();
                // eslint-disable-next-line no-await-in-loop
                const result = await minifyInWorker(worker, job);
                if (result) {
                    results.set(job.file, result);
                }
            }
        } finally {
            await worker.terminate();
        }
    };
    const workers = Array.from({ length: getWorkerCount(queue.length) }, runWorker);
    const failures = (await Promise.allSettled(workers)).filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
        log(`a minify worker failed (${failures[0].reason.message})`);
    }
    return results;
};

/**
 * Produces the minified version of every file the plugin is about to minify, from the cache
 * or the workers, and hands each to the plugin through `asset.__UglifyJsPlugin`.
 */
const preMinify = async ({ plugin, pluginPath, compiler, compilation, chunks }) => {
    const { options } = plugin;
    const optionsKey = serialiseOptions(options);
    if (optionsKey === null) {
        log('these UglifyJsPlugin options are not supported; minifying as usual');
        return;
    }
    const requireFromPlugin = Module.createRequire(pluginPath);
    const ModuleFilenameHelpers = requireFromPlugin('webpack/lib/ModuleFilenameHelpers');
    const { RawSource } = requireFromPlugin('webpack-sources');
    const keyPrefix = [
        `format ${CACHE_FORMAT}`,
        `uglifyjs-webpack-plugin ${readPackageVersion(
            requireFromPlugin,
            'uglifyjs-webpack-plugin',
        )}`,
        `uglify-js ${readPackageVersion(requireFromPlugin, 'uglify-js')}`,
        optionsKey,
    ].join('\0');

    // The same files, in the same way, as the plugin selects them.
    const files = [];
    chunks.forEach((chunk) => files.push(...chunk.files));
    files.push(...compilation.additionalChunkAssets);
    const selected = [...new Set(files)].filter((file) =>
        ModuleFilenameHelpers.matchObject(options, file),
    );

    const cacheDir = getCacheDir(process.env.STENCIL_BUILD_CACHE_DIR);
    const done = new Map();
    const jobs = [];
    for (const file of selected) {
        const asset = compilation.assets[file];
        // eslint-disable-next-line no-underscore-dangle
        const input = asset && !asset.__UglifyJsPlugin ? asset.source() : null;
        if (typeof input === 'string') {
            const key = crypto
                .createHash('sha256')
                .update(`${keyPrefix}\0${file}\0`)
                .update(input)
                .digest('hex');
            const entry = cacheDir && readEntry(cacheDir, key);
            if (entry) {
                done.set(file, { asset, entry });
            } else {
                jobs.push({ file, asset, input, key });
            }
        }
    }

    // Monotonic: the wall clock can jump (it does on WSL), which would garble the duration.
    const started = performance.now();
    const minified =
        jobs.length > 0
            ? await minifyAll(jobs, { pluginPath, options, context: compiler.context })
            : new Map();
    for (const job of jobs) {
        const entry = minified.get(job.file);
        if (entry) {
            done.set(job.file, { asset: job.asset, entry });
            if (cacheDir) {
                try {
                    writeEntry(cacheDir, job.key, entry);
                } catch (err) {
                    log(`could not save ${job.file} (${err.message})`);
                }
            }
        }
    }

    // In the plugin's order, so its warnings come out in the usual order too.
    for (const file of selected.filter((name) => done.has(name))) {
        const { asset, entry } = done.get(file);
        // What the plugin does with a file it minified itself.
        // eslint-disable-next-line no-param-reassign, no-underscore-dangle
        asset.__UglifyJsPlugin = new RawSource(entry.code);
        if (entry.warnings.length > 0) {
            compilation.warnings.push(
                new Error(`${file} from UglifyJs\n${entry.warnings.join('\n')}`),
            );
        }
    }

    log(
        `${selected.length - jobs.length} of ${selected.length} files reused` +
            `${cacheDir ? '' : ' (no cache directory)'}, ${minified.size} minified in parallel` +
            ` in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
    if (cacheDir && jobs.length > 0) {
        try {
            pruneCache(cacheDir);
        } catch (err) {
            log(`could not prune the cache (${err.message})`);
        }
    }
};

/**
 * @param {Function} UglifyJsPlugin - the theme's uglifyjs-webpack-plugin 0.4.x
 * @param {string} pluginPath - its resolved file
 * @returns {Function} the same plugin with the cache and workers in front of it
 */
const withMinifyCache = (UglifyJsPlugin, pluginPath) =>
    class CachedUglifyJsPlugin extends UglifyJsPlugin {
        apply(compiler) {
            // Registered before the plugin's own handler, which it therefore runs right before.
            compiler.plugin('compilation', (compilation) => {
                compilation.plugin('optimize-chunk-assets', (chunks, callback) => {
                    preMinify({ plugin: this, pluginPath, compiler, compilation, chunks })
                        .catch((err) => log(`skipped (${err.stack})`))
                        .then(() => callback());
                });
            });
            super.apply(compiler);
        }
    };

// Module._load is Node's own (undocumented but stable) loader entry point.
// eslint-disable-next-line no-underscore-dangle
const originalLoad = Module._load;
const replaced = new WeakMap();

// eslint-disable-next-line no-underscore-dangle
Module._load = function load(request, parent, isMain) {
    const exported = originalLoad.call(this, request, parent, isMain);
    if (
        request !== 'uglifyjs-webpack-plugin' ||
        typeof exported !== 'function' ||
        !parent ||
        typeof parent.filename !== 'string' ||
        !parent.filename.endsWith(path.sep + WEBPACK3_PLUGIN_MODULE)
    ) {
        return exported;
    }
    if (!replaced.has(exported)) {
        try {
            // eslint-disable-next-line no-underscore-dangle
            const pluginPath = Module._resolveFilename(request, parent, isMain);
            const version = readPackageVersion(Module.createRequire(pluginPath), request);
            replaced.set(
                exported,
                SUPPORTED_PLUGIN_VERSION.test(version)
                    ? withMinifyCache(exported, pluginPath)
                    : exported,
            );
        } catch (err) {
            log(`not used (${err.message})`);
            replaced.set(exported, exported);
        }
    }
    return replaced.get(exported);
};
