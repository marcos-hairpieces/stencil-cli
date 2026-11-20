import path from 'path';
import StencilStyles from '@bigcommerce/stencil-styles';

const SASS_ENGINE_NAME = 'node-sass';
/**
 * @param {object} configuration - theme configuration for the variation being compiled
 * @param {string} themeAssetsPath
 * @param {string} fileName
 * @param {string} [engineName]
 * @param {object} [options]
 * @param {boolean} [options.sourceMap] - embed a source map; worth its size only while developing
 */
const compile = async (
    configuration,
    themeAssetsPath,
    fileName,
    engineName = SASS_ENGINE_NAME,
    { sourceMap = true } = {},
) => {
    const fileParts = path.parse(fileName);
    const ext = configuration.css_compiler === 'css' ? configuration.css_compiler : 'scss';
    const pathToFile = path.join(fileParts.dir, `${fileParts.name}.${ext}`);
    const basePath = path.join(themeAssetsPath, `${ext}`);
    const stencilStyles = new StencilStyles(console);

    let files;
    try {
        files = await stencilStyles.assembleCssFiles(pathToFile, basePath, `${ext}`, {});
    } catch (err) {
        console.error(err);
        throw err;
    }
    const params = {
        data: files[pathToFile],
        files,
        dest: path.join('/assets/css', fileName),
        themeSettings: configuration.settings,
        sourceMap,
        autoprefixerOptions: {
            cascade: configuration.autoprefixer_cascade,
            overrideBrowserslist: configuration.autoprefixer_browsers,
        },
    };
    stencilStyles.activateEngine(engineName);
    return stencilStyles.compileCss('scss', params);
};

export default {
    compile,
    SASS_ENGINE_NAME,
};
