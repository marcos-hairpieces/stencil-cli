import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { reuseOrBuild } from './theme-build-cache.js';

describe('reuseOrBuild', () => {
    let themePath;
    let cacheDir;
    const dist = (file) => path.join(themePath, 'assets/dist', file);
    // Stands in for webpack: a bundle derived from the current JS source.
    const fakeBuild = () =>
        jest.fn(async () => {
            const source = fs.readFileSync(path.join(themePath, 'assets/js/app.js'), 'utf8');
            fs.mkdirSync(path.join(themePath, 'assets/dist'), { recursive: true });
            fs.writeFileSync(dist('bundle.js'), `built(${source})`);
        });
    const run = (build) => reuseOrBuild({ themePath, cacheDir, variant: 'bundle', build });

    beforeEach(() => {
        themePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-reuse-theme-'));
        cacheDir = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-reuse-cache-')),
            'build',
        );
        fs.mkdirSync(path.join(themePath, 'assets/js'), { recursive: true });
        fs.writeFileSync(path.join(themePath, 'assets/js/app.js'), 'v1');
    });

    afterEach(() => {
        fs.rmSync(themePath, { recursive: true, force: true });
        fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true });
    });

    it('should reuse the stored build when the JavaScript has not changed', async () => {
        await run(fakeBuild());
        const second = fakeBuild();

        const result = await run(second);

        expect(result.reused).toBe(true);
        expect(second).not.toHaveBeenCalled();
        expect(fs.readFileSync(dist('bundle.js'), 'utf8')).toBe('built(v1)');
    });

    it('should replace an older assets/dist rather than merge into it', async () => {
        await run(fakeBuild());
        // e.g. left behind by a development build
        fs.writeFileSync(dist('dev-only.js'), 'stale');

        await run(fakeBuild());

        expect(fs.existsSync(dist('dev-only.js'))).toBe(false);
        expect(fs.readFileSync(dist('bundle.js'), 'utf8')).toBe('built(v1)');
    });

    it('should build again when the JavaScript changed', async () => {
        await run(fakeBuild());
        fs.writeFileSync(path.join(themePath, 'assets/js/app.js'), 'v2');
        const second = fakeBuild();

        const result = await run(second);

        expect(result.reused).toBe(false);
        expect(second).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(dist('bundle.js'), 'utf8')).toBe('built(v2)');
    });

    it('should pass a failing build through and store nothing', async () => {
        const failing = jest.fn(async () => {
            throw new Error('webpack failed');
        });

        await expect(run(failing)).rejects.toThrow('webpack failed');
        const next = fakeBuild();
        await run(next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});
