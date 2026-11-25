/**
 * Worker thread for uglify-cache.cjs: minifies one file at a time by running the theme's own
 * uglifyjs-webpack-plugin 0.4.x on a compilation that holds just that file, so the result is
 * the one the plugin would produce in the build itself.
 *
 * workerData: { pluginPath, options, context }. Each message is { file, input }; the reply is
 * { code, warnings }, or null when the plugin reported an error (the build process then
 * minifies that file itself, so the error is reported exactly as usual).
 */
const Module = require('module');
const { parentPort, workerData } = require('worker_threads');

const { pluginPath, options, context } = workerData;
// eslint-disable-next-line import/no-dynamic-require
const UglifyJsPlugin = require(pluginPath);
const { RawSource } = Module.createRequire(pluginPath)('webpack-sources');

const minify = ({ file, input }) => {
    let optimizeChunkAssets;
    const compilation = {
        assets: { [file]: new RawSource(input) },
        additionalChunkAssets: [],
        warnings: [],
        errors: [],
        plugin(name, handler) {
            if (name === 'optimize-chunk-assets') {
                optimizeChunkAssets = handler;
            }
        },
    };
    const compiler = {
        context,
        plugin(name, handler) {
            if (name === 'compilation') {
                handler(compilation);
            }
        },
    };
    // A fresh copy of the options: the plugin fills in defaults on the object it is given.
    new UglifyJsPlugin(structuredClone(options)).apply(compiler);
    // The plugin's handler is synchronous; the callback runs before it returns.
    optimizeChunkAssets([{ files: [file] }], () => {});
    if (compilation.errors.length > 0) {
        return null;
    }
    // The plugin reports one warning per file: "<file> from UglifyJs\n<warning>\n<warning>…".
    const warnings = compilation.warnings.flatMap((warning) =>
        warning.message.split('\n').slice(1),
    );
    return { code: compilation.assets[file].source(), warnings };
};

parentPort.on('message', (job) => {
    parentPort.postMessage(minify(job));
});
