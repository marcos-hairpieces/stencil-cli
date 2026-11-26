import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { jest } from '@jest/globals';
import Server from '../../index.js';
import ThemeConfig from '../../../lib/theme-config.js';
import { precompileStylesheets, PRECOMPILED_DIR } from '../../../lib/css-precompile.js';

const configId = (variation) => `00000000-0000-0000-0000-00000000000${variation}`;
const cssUrl = (variation) => `/stencil/${configId(1)}/css/theme-${configId(variation)}.css`;

describe('ThemeAssets stylesheets with an immutable theme', () => {
    let themePath;
    let themeConfig;
    let server;

    beforeAll(async () => {
        jest.spyOn(console, 'log').mockImplementation(jest.fn());
        // A copy, so a test can change a stylesheet after it has been served.
        themePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-theme-assets-'));
        fs.cpSync(path.join(process.cwd(), 'test/_mocks/themes/valid'), themePath, {
            recursive: true,
        });
        themeConfig = ThemeConfig.getInstance(themePath);
        server = await Server.create({
            dotStencilFile: {
                storeUrl: 'https://store-abc123.mybigcommerce.com',
                normalStoreUrl: 'http://s123456789.mybigcommerce.com',
                port: 4010,
            },
            themePath,
            immutableTheme: true,
            showLogo: false,
        });
    });

    afterAll(async () => {
        await server.stop();
        fs.rmSync(themePath, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('should serve the same stylesheet gzipped or plain, revalidating by ETag', async () => {
        const plain = await server.inject({ url: cssUrl(1) });
        const gzipped = await server.inject({
            url: cssUrl(1),
            headers: { 'accept-encoding': 'gzip' },
        });
        const revalidated = await server.inject({
            url: cssUrl(1),
            headers: { 'accept-encoding': 'gzip', 'if-none-match': gzipped.headers.etag },
        });

        expect(plain.statusCode).toBe(200);
        expect(plain.headers['content-type']).toContain('text/css');
        expect(plain.payload).toContain('h1');
        expect(plain.payload).not.toContain('sourceMappingURL');
        expect(gzipped.headers['content-encoding']).toBe('gzip');
        expect(zlib.gunzipSync(gzipped.rawPayload).toString()).toEqual(plain.payload);
        expect(revalidated.statusCode).toBe(304);
    });

    it('should compile a stylesheet once instead of on every request', async () => {
        const first = await server.inject({ url: cssUrl(1) });
        fs.appendFileSync(
            path.join(themePath, 'assets/scss/theme.scss'),
            '\n.added { color: red; }',
        );
        const second = await server.inject({ url: cssUrl(1) });

        expect(second.payload).toEqual(first.payload);
        expect(second.payload).not.toContain('.added');
    });

    it('should not switch the variation pages render with', async () => {
        themeConfig.setVariation(0);

        const response = await server.inject({ url: cssUrl(2) });

        expect(response.statusCode).toBe(200);
        expect(themeConfig.variationIndex).toBe(0);
    });

    it('should precompile every top-level stylesheet', async () => {
        const result = await server.plugins.ThemeAssets.warmCssCache(0, { error: jest.fn() });

        expect(result.compiled.sort()).toEqual(['checkout', 'theme']);
        expect(result.failed).toEqual([]);
    });
});

describe('ThemeAssets with stylesheets precompiled by the image build', () => {
    let themePath;
    let server;

    beforeAll(async () => {
        jest.spyOn(console, 'log').mockImplementation(jest.fn());
        themePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-theme-assets-pre-'));
        fs.cpSync(path.join(process.cwd(), 'test/_mocks/themes/valid'), themePath, {
            recursive: true,
        });
        await precompileStylesheets({ themePath, logger: { log: jest.fn(), error: jest.fn() } });
        // Marks the precompiled copy, to tell it apart from a fresh compile.
        const [dir] = fs.readdirSync(path.join(themePath, PRECOMPILED_DIR));
        fs.appendFileSync(
            path.join(themePath, PRECOMPILED_DIR, dir, 'theme.css'),
            '\n.from-the-image{}',
        );
        // The router reads the variation from the shared instance; point it at this theme.
        ThemeConfig.getInstance(themePath);
        server = await Server.create({
            dotStencilFile: {
                storeUrl: 'https://store-abc123.mybigcommerce.com',
                normalStoreUrl: 'http://s123456789.mybigcommerce.com',
                port: 4011,
            },
            themePath,
            immutableTheme: true,
            showLogo: false,
        });
    });

    afterAll(async () => {
        await server.stop();
        fs.rmSync(themePath, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('should be ready only once the stylesheets are loaded, and serve the precompiled ones', async () => {
        const readyBefore = server.plugins.ThemeAssets.isReady();

        const result = await server.plugins.ThemeAssets.warmCssCache(0, { error: jest.fn() });
        const response = await server.inject({ url: cssUrl(1) });

        expect(readyBefore).toBe(false);
        expect(result).toEqual({ compiled: ['theme', 'checkout'], failed: [], precompiled: true });
        expect(server.plugins.ThemeAssets.isReady()).toBe(true);
        expect(response.payload).toContain('.from-the-image');
    });
});
