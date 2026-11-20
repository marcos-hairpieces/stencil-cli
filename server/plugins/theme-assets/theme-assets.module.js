import { defaultsDeep } from 'lodash-es';
import * as Boom from '@hapi/boom';
import Crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';
import { uuidRegExp, uuid2int } from '../../lib/utils.js';
import cssCompiler from '../../../lib/css/compile.js';
import ThemeConfig from '../../../lib/theme-config.js';

const gzip = promisify(zlib.gzip);

const internals = {
    options: {},
    // `${variationIndex}\0${fileName}` -> Promise<{css, gzipped, etag}>, only for an immutable theme
    cssCache: null,
};
function register(server, options) {
    // Read before defaultsDeep, which back-fills options from a previous registration.
    const immutableTheme = options.immutableTheme === true;
    internals.options = defaultsDeep(options, internals.options);
    internals.cssCache = immutableTheme ? new Map() : null;
    server.expose('cssHandler', internals.cssHandler);
    server.expose('assetHandler', internals.assetHandler);
    server.expose('warmCssCache', internals.warmCssCache);
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
    try {
        const css = await cssCompiler.compile(configuration, themeAssetsPath, fileName);
        return h.response(css).type('text/css');
    } catch (err) {
        console.error(err);
        throw Boom.badData(err);
    }
};
/**
 * Compiles a stylesheet of an immutable theme once per variation; concurrent requests for the
 * same file share one compilation. The variation's configuration comes from a private
 * ThemeConfig so a stylesheet request never switches the variation pages render with.
 *
 * @param {number} variationIndex
 * @param {string} fileName - stylesheet name without extension or config id
 * @returns {Promise<{css: string, gzipped: Buffer, etag: string}>}
 */
internals.getCachedCss = (variationIndex, fileName) => {
    const key = `${variationIndex}\0${fileName}`;
    let promise = internals.cssCache.get(key);
    if (!promise) {
        promise = (async () => {
            const themeConfig = ThemeConfig.create(internals.options.themePath);
            themeConfig.setVariation(variationIndex);
            const configuration = await themeConfig.getConfig();
            const css = await cssCompiler.compile(
                configuration,
                internals.getThemeAssetsPath(),
                fileName,
                cssCompiler.SASS_ENGINE_NAME,
                { sourceMap: false },
            );
            const etag = Crypto.createHash('sha1').update(css).digest('hex');
            return { css, gzipped: await gzip(css), etag };
        })();
        internals.cssCache.set(key, promise);
        // A failed compile is not cached, so the next request reports the error again.
        promise.catch(() => internals.cssCache.delete(key));
    }
    return promise;
};
/**
 * Compiles every top-level stylesheet of an immutable theme for one variation, one at a time,
 * so the first visitor does not wait for SCSS compilation. Partials (`_name.scss`) are skipped
 * because they are only ever imported. Failures are reported per file and do not stop the rest.
 *
 * @param {number} variationIndex
 * @param {object} [logger]
 * @returns {Promise<{compiled: string[], failed: string[]}>}
 */
internals.warmCssCache = async (variationIndex = 0, logger = console) => {
    if (!internals.cssCache) {
        return { compiled: [], failed: [] };
    }
    const themeConfig = ThemeConfig.create(internals.options.themePath);
    const { css_compiler: cssCompilerName } = await themeConfig.getRawConfig();
    const ext = cssCompilerName === 'css' ? 'css' : 'scss';
    let entries;
    try {
        entries = await fs.readdir(path.join(internals.getThemeAssetsPath(), ext));
    } catch (err) {
        return { compiled: [], failed: [] };
    }
    const fileNames = entries
        .filter((entry) => entry.endsWith(`.${ext}`) && !entry.startsWith('_'))
        .map((entry) => entry.slice(0, -(ext.length + 1)))
        // The main stylesheet first: every page links it.
        .sort((a, b) => (b === 'theme') - (a === 'theme') || a.localeCompare(b));
    const compiled = [];
    const failed = [];
    for (const fileName of fileNames) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await internals.getCachedCss(variationIndex, fileName);
            compiled.push(fileName);
        } catch (err) {
            failed.push(fileName);
            logger.error(`Could not precompile ${fileName}.${ext}: ${err.message || err}`);
        }
    }
    return { compiled, failed };
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
