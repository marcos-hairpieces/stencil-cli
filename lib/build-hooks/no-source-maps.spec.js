import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOOK = fileURLToPath(new URL('./no-source-maps.cjs', import.meta.url));

describe('no-source-maps build hook', () => {
    let dir;

    // A stand-in for webpack that reports the devtool each config reached it with.
    const run = (preload) =>
        JSON.parse(
            execFileSync(process.execPath, [...preload, 'build.js'], { cwd: dir }).toString(),
        );

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-no-source-maps-'));
        fs.mkdirSync(path.join(dir, 'node_modules/webpack'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'node_modules/webpack/index.js'),
            `module.exports = (config, done) => done([].concat(config).map((c) => c.devtool));
            module.exports.version = '4.47.0';`,
        );
        fs.writeFileSync(
            path.join(dir, 'build.js'),
            `const webpack = require('webpack');
            webpack(
                [{ devtool: 'source-map', mode: 'production' }, { devtool: false }],
                (devtools) => process.stdout.write(JSON.stringify({ devtools, version: webpack.version })),
            );`,
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('should turn source maps off in every config webpack is called with', () => {
        expect(run(['--require', HOOK])).toEqual({
            devtools: [false, false],
            version: '4.47.0',
        });
    });

    it('should leave the build untouched when it is not loaded', () => {
        expect(run([]).devtools).toEqual(['source-map', false]);
    });
});
