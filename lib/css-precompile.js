/**
 * Theme stylesheets compiled ahead of time, for container images.
 *
 * `stencil serve` compiles every top-level stylesheet when it starts (SCSS takes ~10 s for a
 * large theme), and a page opened meanwhile waits for it. When the image build compiles them
 * instead (`stencil init` with STENCIL_INIT_BUILD=1, or `stencil-serve --precompile-css`),
 * the server loads the CSS from disk and is ready as soon as it listens.
 *
 * Compiled files live in <theme>/.stencil-css/<variation>-<fingerprint>/. The fingerprint
 * covers everything the compiled CSS depends on: the stylesheet sources, the variation's
 * resolved settings and compiler options, package-lock.json (stylesheets imported from
 * node_modules) and the stencil-cli version. The server only uses a directory whose
 * fingerprint matches what it would compile right now, so a config.json or stylesheet changed
 * after precompiling is compiled at startup as before, never served stale.
 *
 * With a build cache directory (STENCIL_BUILD_CACHE_DIR, a BuildKit cache mount), compiled
 * stylesheets are also kept there by fingerprint, so an image build whose stylesheets and
 * settings did not change copies them instead of compiling.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PACKAGE_INFO } from '../constants.js';
// css/compile.js (node-sass, native code) is imported only where stylesheets are compiled:
// the server imports this module to read precompiled CSS and must not load the compiler.
import ThemeConfig from './theme-config.js';

const PRECOMPILED_DIR = '.stencil-css';
const MANIFEST = 'manifest.json';

/**
 * Top-level stylesheets of a theme: the files under assets/scss (or assets/css) that are not
 * partials (`_name.scss`, only ever imported), the main stylesheet first.
 *
 * @param {string} themePath
 * @param {string} [cssCompilerName] - the theme's css_compiler setting
 * @returns {{ext: string, fileNames: string[]}}
 */
const listStylesheets = (themePath, cssCompilerName) => {
    const ext = cssCompilerName === 'css' ? 'css' : 'scss';
    let entries;
    try {
        entries = fs.readdirSync(path.join(themePath, 'assets', ext));
    } catch (err) {
        return { ext, fileNames: [] };
    }
    const fileNames = entries
        .filter((entry) => entry.endsWith(`.${ext}`) && !entry.startsWith('_'))
        .map((entry) => entry.slice(0, -(ext.length + 1)))
        .sort((a, b) => (b === 'theme') - (a === 'theme') || a.localeCompare(b));
    return { ext, fileNames };
};

const hashTree = (hash, root, dir = root) => {
    const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            hashTree(hash, root, full);
        } else if (entry.isFile()) {
            hash.update(`${path.relative(root, full)}\0`)
                .update(fs.readFileSync(full))
                .update('\0');
        }
    }
};

/**
 * @param {string} themePath
 * @param {number} variationIndex
 * @returns {Promise<{configuration: object, ext: string, fileNames: string[], fingerprint: string}>}
 */
const describeStylesheets = async (themePath, variationIndex) => {
    const themeConfig = ThemeConfig.create(themePath);
    themeConfig.setVariation(variationIndex);
    const configuration = await themeConfig.getConfig();
    const { ext, fileNames } = listStylesheets(themePath, configuration.css_compiler);
    const hash = crypto.createHash('sha256');
    hash.update(`stencil-cli ${PACKAGE_INFO.version}\0`);
    // What css/compile.js passes to the compiler besides the files.
    hash.update(
        JSON.stringify({
            settings: configuration.settings,
            css_compiler: configuration.css_compiler,
            autoprefixer_cascade: configuration.autoprefixer_cascade,
            autoprefixer_browsers: configuration.autoprefixer_browsers,
        }),
    );
    const sources = path.join(themePath, 'assets', ext);
    if (fs.existsSync(sources)) {
        hashTree(hash, sources);
    }
    const lockfile = path.join(themePath, 'package-lock.json');
    if (fs.existsSync(lockfile)) {
        hash.update('package-lock.json\0').update(fs.readFileSync(lockfile));
    }
    return { configuration, ext, fileNames, fingerprint: hash.digest('hex').slice(0, 24) };
};

const dirName = (variationIndex, fingerprint) => `${variationIndex}-${fingerprint}`;

const readCompiledDir = (dir) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return new Map(
        manifest.files.map((fileName) => [
            fileName,
            fs.readFileSync(path.join(dir, `${fileName}.css`), 'utf8'),
        ]),
    );
};

// Files first, manifest last, in a temporary directory renamed into place: a reader never sees
// a directory without all of its files.
const writeCompiledDir = (dir, stylesheets) => {
    const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        for (const [fileName, css] of stylesheets) {
            fs.writeFileSync(path.join(tmp, `${fileName}.css`), css);
        }
        fs.writeFileSync(
            path.join(tmp, MANIFEST),
            JSON.stringify({ files: [...stylesheets.keys()] }),
        );
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmp, dir);
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
    }
};

/**
 * Stylesheets precompiled for this exact theme state, if there are any.
 *
 * @param {string} themePath
 * @param {number} [variationIndex]
 * @returns {Promise<Map<string, string>|null>} file name (no extension) -> CSS
 */
const loadPrecompiled = async (themePath, variationIndex = 0) => {
    const { fingerprint, fileNames } = await describeStylesheets(themePath, variationIndex);
    const dir = path.join(themePath, PRECOMPILED_DIR, dirName(variationIndex, fingerprint));
    if (fileNames.length === 0 || !fs.existsSync(path.join(dir, MANIFEST))) {
        return null;
    }
    const stylesheets = readCompiledDir(dir);
    return fileNames.every((fileName) => stylesheets.has(fileName)) ? stylesheets : null;
};

/**
 * Compiles every top-level stylesheet of one variation into <theme>/.stencil-css, or copies
 * them from the build cache when an earlier build compiled the same inputs. Older
 * precompiled directories are removed. If any stylesheet fails to compile nothing is written,
 * so the server compiles at startup and reports the error the way it always has.
 *
 * @param {object} options
 * @param {string} options.themePath
 * @param {number} [options.variationIndex]
 * @param {string} [options.cacheDir] - persists between image builds; used only if it exists
 * @param {object} [options.logger]
 * @returns {Promise<{status: 'compiled'|'restored'|'none'|'failed', count: number}>}
 */
const precompileStylesheets = async ({
    themePath,
    variationIndex = 0,
    cacheDir,
    logger = console,
}) => {
    const { configuration, fileNames, fingerprint } = await describeStylesheets(
        themePath,
        variationIndex,
    );
    if (fileNames.length === 0) {
        return { status: 'none', count: 0 };
    }
    const root = path.join(themePath, PRECOMPILED_DIR);
    const name = dirName(variationIndex, fingerprint);
    const target = path.join(root, name);
    const cached = cacheDir && fs.existsSync(cacheDir) ? path.join(cacheDir, 'css', name) : null;
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root)) {
        if (entry !== name) {
            fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        }
    }

    if (cached && fs.existsSync(path.join(cached, MANIFEST))) {
        try {
            writeCompiledDir(target, readCompiledDir(cached));
            return { status: 'restored', count: fileNames.length };
        } catch (err) {
            logger.error(`Could not use the stylesheets in the build cache: ${err.message}`);
        }
    }

    const assetsPath = path.join(themePath, 'assets');
    // eslint-disable-next-line node/no-unsupported-features/es-syntax
    const { default: cssCompiler } = await import('./css/compile.js');
    const stylesheets = new Map();
    for (const fileName of fileNames) {
        try {
            // Exactly what the server's compile worker does (css-compile-worker.js).
            // eslint-disable-next-line no-await-in-loop
            const css = await cssCompiler.compile(
                configuration,
                assetsPath,
                fileName,
                cssCompiler.SASS_ENGINE_NAME,
                { sourceMap: false },
            );
            stylesheets.set(fileName, css);
        } catch (err) {
            logger.error(
                `Could not precompile ${fileName}: ${
                    (err && (err.formatted || err.message)) || err
                }`,
            );
            return { status: 'failed', count: 0 };
        }
    }
    writeCompiledDir(target, stylesheets);
    if (cached) {
        try {
            fs.mkdirSync(path.dirname(cached), { recursive: true });
            writeCompiledDir(cached, stylesheets);
        } catch (err) {
            // The stylesheets are in the image; a cache that cannot be written only costs speed.
            logger.error(`Could not save the stylesheets to the build cache: ${err.message}`);
        }
    }
    return { status: 'compiled', count: stylesheets.size };
};

/**
 * precompileStylesheets for an image build, with the outcome logged. Never throws: an image
 * without precompiled stylesheets still works, its server compiles them at startup.
 *
 * @param {object} options - as for precompileStylesheets
 * @returns {Promise<void>}
 */
const precompileForImage = async ({ logger = console, ...options }) => {
    let result;
    try {
        result = await precompileStylesheets({ logger, ...options });
    } catch (err) {
        logger.error(`Could not precompile the stylesheets: ${err.message}`);
        return;
    }
    const messages = {
        compiled: `ok -- ${result.count} stylesheet(s) precompiled into ${PRECOMPILED_DIR}`,
        restored: `ok -- ${result.count} stylesheet(s) restored from the build cache; no stylesheet or setting changed`,
        none: 'the theme has no stylesheets to precompile',
        failed: 'stylesheets not precompiled; the server compiles them when it starts',
    };
    logger.log(messages[result.status]);
};

export {
    PRECOMPILED_DIR,
    listStylesheets,
    loadPrecompiled,
    precompileStylesheets,
    precompileForImage,
};
