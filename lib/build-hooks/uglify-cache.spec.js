import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOOK = fileURLToPath(new URL('./uglify-cache.cjs', import.meta.url));

// A stand-in for webpack 3 and its uglifyjs-webpack-plugin 0.4.x: the plugin "minifies" by
// upper-casing, follows the real plugin's protocol (it skips an asset that carries
// `__UglifyJsPlugin`), and logs which thread minified each file.
const FIXTURE = {
    'node_modules/webpack/package.json': '{"name":"webpack","version":"3.12.0"}',
    'node_modules/webpack/index.js': `module.exports = {
        optimize: { get UglifyJsPlugin() { return require('./lib/optimize/UglifyJsPlugin'); } },
    };`,
    'node_modules/webpack/lib/optimize/UglifyJsPlugin.js':
        "module.exports = require('uglifyjs-webpack-plugin');",
    'node_modules/webpack/lib/ModuleFilenameHelpers.js':
        'exports.matchObject = (options, file) => options.test.test(file);',
    'node_modules/webpack-sources/index.js': `exports.RawSource = class RawSource {
        constructor(value) { this._value = value; }
        source() { return this._value; }
    };`,
    'node_modules/uglify-js/package.json': '{"name":"uglify-js","version":"2.8.29"}',
    'node_modules/uglifyjs-webpack-plugin/package.json':
        '{"name":"uglifyjs-webpack-plugin","version":"0.4.6"}',
    'node_modules/uglifyjs-webpack-plugin/index.js': `
        const fs = require('fs');
        const { threadId } = require('worker_threads');
        const { RawSource } = require('webpack-sources');
        const ModuleFilenameHelpers = require('webpack/lib/ModuleFilenameHelpers');
        module.exports = class UglifyJsPlugin {
            constructor(options) { this.options = options || {}; }
            apply(compiler) {
                const options = this.options;
                options.test = options.test || /\\.js$/;
                compiler.plugin('compilation', (compilation) => {
                    compilation.plugin('optimize-chunk-assets', (chunks, callback) => {
                        const files = [];
                        chunks.forEach((chunk) => files.push(...chunk.files));
                        files.push(...compilation.additionalChunkAssets);
                        files.filter((file) => ModuleFilenameHelpers.matchObject(options, file)).forEach((file) => {
                            const asset = compilation.assets[file];
                            if (asset.__UglifyJsPlugin) {
                                compilation.assets[file] = asset.__UglifyJsPlugin;
                                return;
                            }
                            const input = asset.source();
                            fs.appendFileSync(process.env.MINIFY_LOG, (threadId ? 'worker ' : 'build ') + file + '\\n');
                            if (input.includes('syntax error')) {
                                compilation.errors.push(new Error(file + ' from UglifyJs\\nUnexpected token'));
                                return;
                            }
                            asset.__UglifyJsPlugin = compilation.assets[file] = new RawSource(input.toUpperCase());
                            compilation.warnings.push(new Error(file + ' from UglifyJs\\nDropping unused ' + file));
                        });
                        callback();
                    });
                });
            }
        };`,
    // Runs one compilation of the assets in assets.json through the plugin, like webpack does.
    'build.js': `
        const fs = require('fs');
        const webpack = require('webpack');
        const assets = {};
        for (const [file, source] of Object.entries(JSON.parse(fs.readFileSync('assets.json')))) {
            assets[file] = { source: () => source };
        }
        const options = process.argv[2] === 'function-option' ? { comments: () => false } : { comments: false };
        const plugin = new webpack.optimize.UglifyJsPlugin(options);
        const onCompilation = [];
        const onOptimize = [];
        plugin.apply({ context: __dirname, plugin: (name, handler) => onCompilation.push(handler) });
        const compilation = {
            assets, additionalChunkAssets: [], warnings: [], errors: [],
            plugin: (name, handler) => onOptimize.push(handler),
        };
        onCompilation.forEach((handler) => handler(compilation));
        const chunks = [{ files: Object.keys(assets) }];
        const run = ([handler, ...rest]) => handler
            ? handler(chunks, () => run(rest))
            : fs.writeFileSync('result.json', JSON.stringify({
                assets: Object.fromEntries(Object.entries(compilation.assets).map(([f, a]) => [f, a.source()])),
                warnings: compilation.warnings.map((w) => w.message),
                errors: compilation.errors.map((e) => e.message),
            }));
        run(onOptimize);`,
};

describe('uglify-cache build hook', () => {
    let dir;
    let cacheDir;

    const writeAssets = (assets) =>
        fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify(assets));
    const minifyLog = () => {
        const logFile = path.join(dir, 'minify.log');
        const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        fs.rmSync(logFile, { force: true });
        return lines.split('\n').filter(Boolean).sort();
    };
    const build = ({ hook = true, cache = true, args = [] } = {}) => {
        const preload = hook ? ['--require', HOOK] : [];
        execFileSync(process.execPath, [...preload, 'build.js', ...args], {
            cwd: dir,
            env: {
                ...process.env,
                MINIFY_LOG: path.join(dir, 'minify.log'),
                STENCIL_BUILD_CACHE_DIR: cache ? cacheDir : path.join(dir, 'no-mount'),
            },
            stdio: 'ignore',
        });
        const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
        return { ...result, minified: minifyLog() };
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-uglify-cache-'));
        cacheDir = path.join(dir, 'cache');
        fs.mkdirSync(cacheDir);
        for (const [file, content] of Object.entries(FIXTURE)) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), content);
        }
        writeAssets({ 'main.js': 'main()', 'page.js': 'page()', 'theme.css': 'body{}' });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('should produce what the plugin produces, minifying on worker threads', () => {
        const expected = build({ hook: false });
        expect(expected.minified).toEqual(['build main.js', 'build page.js']);

        const cold = build();

        expect(cold.minified).toEqual(['worker main.js', 'worker page.js']);
        expect({ ...cold, minified: [] }).toEqual({ ...expected, minified: [] });
    });

    it('should only minify the files that changed since an earlier build', () => {
        build();
        writeAssets({ 'main.js': 'main(2)', 'page.js': 'page()', 'theme.css': 'body{}' });
        const expected = build({ hook: false });

        const warm = build();

        expect(warm.minified).toEqual(['worker main.js']);
        expect({ ...warm, minified: [] }).toEqual({ ...expected, minified: [] });
        expect(build().minified).toEqual([]);
    });

    it('should write nothing without the cache directory', () => {
        fs.rmSync(cacheDir, { recursive: true });

        expect(build({ cache: false }).minified).toEqual(['worker main.js', 'worker page.js']);
        expect(build({ cache: false }).minified).toEqual(['worker main.js', 'worker page.js']);
        expect(fs.existsSync(path.join(dir, 'no-mount'))).toBe(false);
    });

    it('should leave a file the plugin fails on to the plugin, which reports it as usual', () => {
        writeAssets({ 'main.js': 'main()', 'page.js': 'syntax error' });
        const expected = build({ hook: false });

        const result = build();

        expect(result.errors).toEqual(['page.js from UglifyJs\nUnexpected token']);
        expect(result.minified).toEqual(['build page.js', 'worker main.js', 'worker page.js']);
        expect({ ...result, minified: [] }).toEqual({ ...expected, minified: [] });
    });

    it('should leave the minifying to the plugin when its options cannot be cached', () => {
        const result = build({ args: ['function-option'] });

        expect(result.minified).toEqual(['build main.js', 'build page.js']);
        expect(fs.readdirSync(cacheDir)).toEqual([]);
    });
});
