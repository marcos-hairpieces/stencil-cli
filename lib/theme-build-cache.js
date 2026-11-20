import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// What the theme JavaScript bundle is built from: the build configuration and lockfile below,
// every file in assets/js, and every file elsewhere in the theme that those files import (some
// themes import config/settings.js or their lang/*.json into the bundle). Nothing else can
// change assets/dist, so templates, styles and the rest of the translations must not invalidate
// the cache. config.json is left out unless the JavaScript imports it: Cornerstone's webpack
// config loads it without using it, and it changes on almost every pull request.
const JS_DIR = 'assets/js';
const INPUT_FILE_PATTERNS = [
    /^package\.json$/,
    /^package-lock\.json$/,
    /^yarn\.lock$/,
    /^pnpm-lock\.yaml$/,
    /^webpack[\w.-]*\.(c|m)?js$/,
    /^stencil\.conf\.(c|m)?js$/,
    /^babel\.config\.\w+$/,
    /^\.babelrc(\.\w+)?$/,
    /^\.browserslistrc$/,
];
// Relative specifiers in `import … from`, `import '…'`, `import('…')` and `require('…')`.
const RELATIVE_IMPORT_REGEX = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.json', '/index.js'];
const SCANNABLE_REGEX = /\.(c|m)?jsx?$|\.ts$/;
// Builds kept in the cache; older ones are removed after each save.
const MAX_ENTRIES = 20;

/**
 * @param {string} dir
 * @returns {string[]} files under dir, relative to it, sorted
 */
const listFiles = (dir) => {
    const files = [];
    const walk = (relative) => {
        for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
            const entryPath = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                walk(entryPath);
            } else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    };
    walk('');
    return files.sort();
};

/**
 * @param {string} fromFile - absolute path of the importing file
 * @param {string} specifier - relative import specifier
 * @returns {string|null} absolute path of the imported file, if it exists
 */
const resolveImport = (fromFile, specifier) => {
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = base + suffix;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
};

/**
 * Files outside assets/js that the theme JavaScript imports, directly or through other such
 * files. Imports that leave the theme (node_modules is covered by the lockfile) are ignored.
 *
 * @param {string} themePath
 * @param {string[]} jsFiles - absolute paths of the files in assets/js
 * @returns {string[]} theme-relative paths, sorted
 */
const findImportedFiles = (themePath, jsFiles) => {
    const jsDir = path.join(themePath, JS_DIR) + path.sep;
    const found = new Set();
    const queue = [...jsFiles];
    while (queue.length > 0) {
        const file = queue.pop();
        if (SCANNABLE_REGEX.test(file)) {
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(RELATIVE_IMPORT_REGEX)) {
                const target = resolveImport(file, match[2]);
                const outsideJsDir = target && !target.startsWith(jsDir);
                const insideTheme = target && target.startsWith(themePath + path.sep);
                if (
                    outsideJsDir &&
                    insideTheme &&
                    !target.includes(`${path.sep}node_modules${path.sep}`)
                ) {
                    const relative = path.relative(themePath, target);
                    if (!found.has(relative)) {
                        found.add(relative);
                        queue.push(target);
                    }
                }
            }
        }
    }
    return [...found].sort();
};

/**
 * Hashes everything the theme JavaScript is built from, so two themes with the same hash
 * produce the same assets/dist.
 *
 * @param {string} themePath
 * @returns {string} hex digest
 */
const hashBuildInputs = (themePath) => {
    const root = path.resolve(themePath);
    const hash = crypto.createHash('sha256');
    // The toolchain is part of the input: a different Node can emit different output.
    hash.update(`node ${process.version} ${process.arch}\0`);
    const inputs = fs
        .readdirSync(root)
        .filter((name) => INPUT_FILE_PATTERNS.some((pattern) => pattern.test(name)))
        .sort();
    if (fs.existsSync(path.join(root, JS_DIR))) {
        const jsFiles = listFiles(path.join(root, JS_DIR)).map((file) => path.join(JS_DIR, file));
        inputs.push(...jsFiles);
        inputs.push(
            ...findImportedFiles(
                root,
                jsFiles.map((file) => path.join(root, file)),
            ),
        );
    }
    for (const file of inputs) {
        hash.update(`${file}\0`);
        hash.update(fs.readFileSync(path.join(root, file)));
        hash.update('\0');
    }
    return hash.digest('hex');
};

/**
 * Copies a cached build into distPath.
 *
 * @param {string} cacheDir
 * @param {string} key
 * @param {string} distPath
 * @returns {boolean} whether a cached build existed
 */
const restoreBuild = (cacheDir, key, distPath) => {
    const entry = path.join(cacheDir, key);
    if (!fs.existsSync(path.join(entry, 'dist'))) {
        return false;
    }
    fs.cpSync(path.join(entry, 'dist'), distPath, { recursive: true });
    // Recency for pruning.
    const now = new Date();
    fs.utimesSync(entry, now, now);
    return true;
};

/**
 * Stores distPath in the cache under key, then prunes the oldest entries. The entry is written
 * under a temporary name and renamed into place, so a concurrent build never reads half of it.
 *
 * @param {string} cacheDir
 * @param {string} key
 * @param {string} distPath
 */
const saveBuild = (cacheDir, key, distPath) => {
    const entry = path.join(cacheDir, key);
    if (fs.existsSync(entry)) {
        return;
    }
    const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
    fs.cpSync(distPath, path.join(tmp, 'dist'), { recursive: true });
    try {
        fs.renameSync(tmp, entry);
    } catch (err) {
        // Another build saved the same key first; its copy is identical.
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    const entries = fs
        .readdirSync(cacheDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && /^[0-9a-f]{64}$/.test(dirent.name))
        .map((dirent) => ({
            name: dirent.name,
            mtime: fs.statSync(path.join(cacheDir, dirent.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(MAX_ENTRIES)) {
        fs.rmSync(path.join(cacheDir, stale.name), { recursive: true, force: true });
    }
};

export { hashBuildInputs, restoreBuild, saveBuild };
