import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { loadPrecompiled, precompileStylesheets, PRECOMPILED_DIR } from './css-precompile.js';

describe('precompiled stylesheets', () => {
    let themePath;
    let cacheDir;
    const logger = { log: jest.fn(), error: jest.fn() };
    const precompile = () => precompileStylesheets({ themePath, cacheDir, logger });
    const setSetting = (name, value) => {
        const file = path.join(themePath, 'config.json');
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        const settings = { ...config.settings, [name]: value };
        fs.writeFileSync(file, JSON.stringify({ ...config, settings }, null, 2));
    };

    beforeEach(() => {
        themePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-css-precompile-'));
        fs.cpSync(path.join(process.cwd(), 'test/_mocks/themes/valid'), themePath, {
            recursive: true,
        });
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-css-cache-'));
    });

    afterEach(() => {
        fs.rmSync(themePath, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('should give the server every top-level stylesheet, compiled', async () => {
        const result = await precompile();
        const loaded = await loadPrecompiled(themePath);

        expect(result).toEqual({ status: 'compiled', count: 2 });
        expect([...loaded.keys()]).toEqual(['theme', 'checkout']);
        expect(loaded.get('theme')).toContain('h1');
        expect(loaded.get('theme')).not.toContain('sourceMappingURL');
    });

    it('should not be used once a stylesheet changed', async () => {
        await precompile();
        fs.appendFileSync(
            path.join(themePath, 'assets/scss/theme.scss'),
            '\n.added { color: red; }',
        );

        expect(await loadPrecompiled(themePath)).toBeNull();
    });

    it('should not be used once a theme setting changed', async () => {
        await precompile();
        setSetting('server_base_url', 'https://example.com');

        expect(await loadPrecompiled(themePath)).toBeNull();
    });

    it('should be restored from the build cache for a theme with the same stylesheets', async () => {
        await precompile();
        fs.rmSync(path.join(themePath, PRECOMPILED_DIR), { recursive: true });

        const result = await precompile();

        expect(result.status).toBe('restored');
        expect((await loadPrecompiled(themePath)).get('theme')).toContain('h1');
    });

    it('should precompile for the final settings and drop the older stylesheets', async () => {
        await precompile();
        setSetting('server_base_url', 'https://example.com');

        await precompile();

        expect(await loadPrecompiled(themePath)).not.toBeNull();
        expect(fs.readdirSync(path.join(themePath, PRECOMPILED_DIR))).toHaveLength(1);
    });

    it('should write nothing when a stylesheet does not compile', async () => {
        fs.appendFileSync(path.join(themePath, 'assets/scss/checkout.scss'), '\n.broken {');

        const result = await precompile();

        expect(result.status).toBe('failed');
        expect(await loadPrecompiled(themePath)).toBeNull();
        expect(fs.readdirSync(cacheDir)).toEqual([]);
    });
});
