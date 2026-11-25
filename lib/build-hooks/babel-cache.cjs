/**
 * Preloaded (`node --require`) into the theme build worker. Keeps babel-loader's cache in the
 * build cache ($STENCIL_BUILD_CACHE_DIR/babel-loader), which survives preview builds, so after a
 * JavaScript change only the changed files go through Babel again.
 *
 * Every `require('webpack')` gets the real webpack wrapped so that each babel-loader in the
 * configs it is called with gets `cacheDirectory` pointed there, when the theme leaves it unset
 * or sets it to `true` (which would cache in node_modules/.cache, thrown away with each preview
 * image build). A theme's own cache path, or `cacheDirectory: false`, is kept.
 *
 * babel-loader reuses a cached result only for the same file contents, loader options and
 * Babel version, so the output is the same as without the cache. Its key does not cover the
 * versions of Babel plugins and presets or the browserslist data, so the cache directory is
 * one per theme dependency state: a hash of the lockfiles, package.json and Babel/browserslist
 * config files. Only the most recently used ones are kept.
 */
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const CACHE_SUBDIR = 'babel-loader';
const KEEP_DIRS = 8;
const DEPENDENCY_FILES = /^(package\.json|package-lock(\.[\w-]+)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.babelrc(\.\w+)?|babel\.config\.\w+|\.browserslistrc)$/;
const BABEL_LOADER = /(^|[\\/])babel-loader([\\/]|$)/;

const log = (message) => console.log(`babel cache: ${message}`);

/**
 * @param {string} themeDir
 * @returns {string} hash of everything that decides Babel's output besides the loader options
 */
const hashDependencies = (themeDir) => {
    const hash = crypto.createHash('sha256');
    for (const name of fs
        .readdirSync(themeDir)
        .filter((n) => DEPENDENCY_FILES.test(n))
        .sort()) {
        hash.update(`${name}\0`)
            .update(fs.readFileSync(path.join(themeDir, name)))
            .update('\0');
    }
    return hash.digest('hex').slice(0, 16);
};

const pruneOldDirs = (baseDir) => {
    const dirs = fs
        .readdirSync(baseDir)
        .map((name) => {
            const dir = path.join(baseDir, name);
            try {
                return { dir, mtime: fs.statSync(dir).mtimeMs };
            } catch (err) {
                return null; // removed by a concurrent prune
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    for (const { dir } of dirs.slice(KEEP_DIRS)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

/**
 * @param {string} [baseDir] - $STENCIL_BUILD_CACHE_DIR
 * @param {string} themeDir
 * @returns {string|null} babel-loader's cache directory, when the build cache is mounted
 */
const getCacheDir = (baseDir, themeDir) => {
    if (!baseDir || !fs.existsSync(baseDir)) {
        return null;
    }
    const parent = path.join(baseDir, CACHE_SUBDIR);
    const dir = path.join(parent, hashDependencies(themeDir));
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    fs.utimesSync(dir, now, now); // recency for pruning
    pruneOldDirs(parent);
    return dir;
};

const withCacheDirectory = (options, cacheDir) => {
    if (options === undefined || options === null) {
        return { cacheDirectory: cacheDir };
    }
    if (
        typeof options === 'object' &&
        (options.cacheDirectory === undefined || options.cacheDirectory === true)
    ) {
        return { ...options, cacheDirectory: cacheDir };
    }
    return options; // a query string, or the theme's own cache choice
};

const isBabelLoader = (loader) =>
    typeof loader === 'string' && BABEL_LOADER.test(loader) && !loader.includes('?');

// One entry of a rule's `use`: a loader name or { loader, options }.
const patchUseEntry = (entry, cacheDir) => {
    if (isBabelLoader(entry)) {
        return { loader: entry, options: { cacheDirectory: cacheDir } };
    }
    if (entry && typeof entry === 'object' && isBabelLoader(entry.loader) && !entry.query) {
        return { ...entry, options: withCacheDirectory(entry.options, cacheDir) };
    }
    return entry;
};

const patchRule = (rule, cacheDir) => {
    if (!rule || typeof rule !== 'object') {
        return rule;
    }
    const patched = { ...rule };
    if (Array.isArray(rule.rules)) {
        patched.rules = rule.rules.map((r) => patchRule(r, cacheDir));
    }
    if (Array.isArray(rule.oneOf)) {
        patched.oneOf = rule.oneOf.map((r) => patchRule(r, cacheDir));
    }
    if (Array.isArray(rule.use)) {
        patched.use = rule.use.map((entry) => patchUseEntry(entry, cacheDir));
    } else if (rule.use !== undefined) {
        patched.use = patchUseEntry(rule.use, cacheDir);
    } else if (isBabelLoader(rule.loader) && !rule.query) {
        patched.options = withCacheDirectory(rule.options, cacheDir);
    }
    return patched;
};

const withBabelCache = (config, cacheDir) => {
    if (Array.isArray(config)) {
        return config.map((c) => withBabelCache(c, cacheDir));
    }
    if (!config || typeof config !== 'object' || !config.module) {
        return config;
    }
    const rulesConfig = config.module;
    const patchedModule = { ...rulesConfig };
    for (const key of ['rules', 'loaders']) {
        if (Array.isArray(rulesConfig[key])) {
            patchedModule[key] = rulesConfig[key].map((r) => patchRule(r, cacheDir));
        }
    }
    return { ...config, module: patchedModule };
};

let cacheDir;
try {
    cacheDir = getCacheDir(process.env.STENCIL_BUILD_CACHE_DIR, process.cwd());
} catch (err) {
    log(`not used (${err.message})`);
    cacheDir = null;
}

// Module._load is Node's own (undocumented but stable) loader entry point.
// eslint-disable-next-line no-underscore-dangle
const originalLoad = Module._load;
const wrapped = new WeakMap();

// eslint-disable-next-line no-underscore-dangle
Module._load = function load(request, parent, isMain) {
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!cacheDir || request !== 'webpack' || typeof exported !== 'function') {
        return exported;
    }
    if (!wrapped.has(exported)) {
        // A Proxy keeps every property of the webpack export (plugins, optimize, version and
        // webpack 4's lazy getters) and only changes what calling it does.
        wrapped.set(
            exported,
            new Proxy(exported, {
                apply(target, thisArg, [config, ...rest]) {
                    return Reflect.apply(target, thisArg, [
                        withBabelCache(config, cacheDir),
                        ...rest,
                    ]);
                },
            }),
        );
    }
    return wrapped.get(exported);
};
