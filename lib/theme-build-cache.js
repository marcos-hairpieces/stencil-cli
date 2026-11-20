import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// What the theme JavaScript bundle is built from. A change to anything else (templates, SCSS,
// translations, config.json) cannot change assets/dist, so it must not invalidate the cache.
// config.json is loaded by Cornerstone's webpack config but not used by it; it is left out
// because it changes on almost every pull request (version bumps).
const INPUT_DIRS = ['assets/js', 'config'];
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
 * Hashes everything the theme JavaScript is built from, so two themes with the same hash
 * produce the same assets/dist.
 *
 * @param {string} themePath
 * @returns {string} hex digest
 */
const hashBuildInputs = (themePath) => {
    const hash = crypto.createHash('sha256');
    // The toolchain is part of the input: a different Node can emit different output.
    hash.update(`node ${process.version} ${process.arch}\0`);
    const inputs = fs
        .readdirSync(themePath)
        .filter((name) => INPUT_FILE_PATTERNS.some((pattern) => pattern.test(name)))
        .sort();
    for (const dir of INPUT_DIRS) {
        if (fs.existsSync(path.join(themePath, dir))) {
            inputs.push(
                ...listFiles(path.join(themePath, dir)).map((file) => path.join(dir, file)),
            );
        }
    }
    for (const file of inputs) {
        hash.update(`${file}\0`);
        hash.update(fs.readFileSync(path.join(themePath, file)));
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
