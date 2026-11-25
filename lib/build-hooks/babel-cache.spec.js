import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOOK = fileURLToPath(new URL('./babel-cache.cjs', import.meta.url));

describe('babel-cache build hook', () => {
    let dir;
    let cacheBase;

    // A stand-in for webpack that reports the babel-loader options each rule reached it with.
    const run = (env = { STENCIL_BUILD_CACHE_DIR: cacheBase }) =>
        JSON.parse(
            execFileSync(process.execPath, ['--require', HOOK, 'build.js'], {
                cwd: dir,
                env: { PATH: process.env.PATH, ...env },
            }).toString(),
        );

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-babel-cache-'));
        cacheBase = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-babel-cache-base-'));
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 1}');
        fs.mkdirSync(path.join(dir, 'node_modules/webpack'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'node_modules/webpack/index.js'),
            `module.exports = (config, done) => done(config.module.rules);
            module.exports.version = '4.47.0';`,
        );
        fs.writeFileSync(
            path.join(dir, 'build.js'),
            `require('webpack')(
                {
                    module: {
                        rules: [
                            { test: /a/, use: { loader: 'babel-loader', options: { presets: ['env'] } } },
                            { test: /b/, loader: 'babel-loader', options: { cacheDirectory: true } },
                            { test: /c/, use: ['style-loader', 'babel-loader'] },
                            { oneOf: [{ use: { loader: 'babel-loader', options: { cacheDirectory: '/own' } } }] },
                            { test: /e/, use: { loader: 'babel-loader', options: { cacheDirectory: false } } },
                            { test: /f/, use: 'css-loader' },
                        ],
                    },
                },
                (rules) => process.stdout.write(JSON.stringify(rules)),
            );`,
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(cacheBase, { recursive: true, force: true });
    });

    it("should cache Babel in the build cache when the theme doesn't choose a place", () => {
        const [a, b, c, nested, e, f] = run();
        const cacheDir = a.use.options.cacheDirectory;

        expect(path.dirname(cacheDir)).toBe(path.join(cacheBase, 'babel-loader'));
        expect(a.use.options.presets).toEqual(['env']);
        expect(b.options.cacheDirectory).toBe(cacheDir);
        expect(c.use).toEqual([
            'style-loader',
            { loader: 'babel-loader', options: { cacheDirectory: cacheDir } },
        ]);
        expect(nested.oneOf[0].use.options.cacheDirectory).toBe('/own');
        expect(e.use.options.cacheDirectory).toBe(false);
        expect(f.use).toBe('css-loader');
    });

    it('should use a new cache when the theme dependencies change', () => {
        const before = run()[0].use.options.cacheDirectory;
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 2}');

        expect(run()[0].use.options.cacheDirectory).not.toBe(before);
    });

    it('should leave the build untouched without a build cache directory', () => {
        const [a, b] = run({});

        expect(a.use.options).toEqual({ presets: ['env'] });
        expect(b.options.cacheDirectory).toBe(true);
    });
});
