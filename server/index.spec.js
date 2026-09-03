import { buildManifest } from './index.js';
import * as manifest from './manifest.js';

describe('buildManifest', () => {
    const getOptions = (overrides = {}) => ({
        dotStencilFile: {
            storeUrl: 'https://store-abc123.mybigcommerce.com',
            normalStoreUrl: 'http://s1234567890.mybigcommerce.com',
            port: 3000,
            accessToken: 'accessToken_value',
            customLayouts: {},
        },
        themePath: '/some/theme/path',
        stencilCliVersion: '9.0.3',
        storeSettingsLocale: { default_shopper_language: 'en_US' },
        useCache: true,
        ...overrides,
    });
    const getPluginOptions = (result, pluginPath) =>
        result.register.plugins.find((entry) => entry.plugin === pluginPath).options;
    const RENDERER = './plugins/renderer/renderer.module.js';
    const ROUTER = './plugins/router/router.module.js';

    describe('port offset', () => {
        it('should default to one above the configured port for the BrowserSync proxy hop', () => {
            const result = buildManifest(manifest.get('/'), getOptions());

            expect(result.server.port).toEqual(3001);
        });

        it('should bind the configured port directly when the offset is zero', () => {
            const result = buildManifest(manifest.get('/'), getOptions({ portOffset: 0 }));

            expect(result.server.port).toEqual(3000);
        });
    });

    describe('development affordances', () => {
        it('should leave debug queries and development flags enabled by default', () => {
            const result = buildManifest(manifest.get('/'), getOptions());

            expect(getPluginOptions(result, RENDERER)).toMatchObject({
                debugQueriesEnabled: true,
                inDevelopment: true,
            });
        });

        it('should disable them when explicitly turned off', () => {
            const result = buildManifest(
                manifest.get('/'),
                getOptions({ debugQueriesEnabled: false, inDevelopment: false }),
            );

            expect(getPluginOptions(result, RENDERER)).toMatchObject({
                debugQueriesEnabled: false,
                inDevelopment: false,
            });
        });
    });

    describe('health check', () => {
        it('should be disabled by default', () => {
            const result = buildManifest(manifest.get('/'), getOptions());

            expect(getPluginOptions(result, ROUTER).healthCheckEnabled).toBe(false);
        });

        it('should be enabled when requested', () => {
            const result = buildManifest(
                manifest.get('/'),
                getOptions({ healthCheckEnabled: true }),
            );

            expect(getPluginOptions(result, ROUTER).healthCheckEnabled).toBe(true);
        });
    });
});
