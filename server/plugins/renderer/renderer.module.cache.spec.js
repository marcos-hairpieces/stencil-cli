import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import path from 'path';
import { jest } from '@jest/globals';
import Server from '../../index.js';
import ThemeConfig from '../../../lib/theme-config.js';

// The renderer keeps its options in a module-level singleton, so these tests build their
// own server instead of sharing the one in renderer.module.spec.js.
const themeConfigManager = ThemeConfig.getInstance(
    path.join(process.cwd(), 'test/_mocks/themes/valid'),
);
const axiosMock = new MockAdapter(axios);
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

describe('Renderer Plugin cache TTL', () => {
    const storeUrl = 'https://store-abc123.mybigcommerce.com';
    const normalStoreUrl = 'http://s123456789.mybigcommerce.com';
    // Long enough that two back-to-back renders comfortably fit inside it on a slow CI box.
    const cacheTTL = 1000;
    const browserRequest = { method: 'get', url: '/checkout.php' };
    const storefrontResponseHeaders = { 'content-type': 'text/html; charset=utf-8' };
    const storefrontResponseBody = '<!DOCTYPE html><html><head></head><body>Checkout</body></html>';
    let server;

    beforeAll(async () => {
        jest.spyOn(console, 'log').mockImplementation(jest.fn());
        jest.spyOn(console, 'error').mockImplementation(jest.fn());
        server = await Server.create({
            dotStencilFile: {
                storeUrl,
                normalStoreUrl,
                port: 4001,
                username: 'testUser',
                token: '6832b1c755bb9de13aa8990216a69a7623043fd7',
            },
            useCache: true,
            cacheTTL,
            themePath: themeConfigManager.themePath,
        });
    });
    beforeEach(() => {
        axiosMock.onGet().reply(200, storefrontResponseBody, storefrontResponseHeaders);
    });
    afterEach(() => {
        jest.resetAllMocks();
        axiosMock.reset();
    });
    afterAll(async () => {
        await server.stop();
    });

    it('should serve a repeated request from the cache while the TTL has not elapsed', async () => {
        await server.inject({ ...browserRequest, url: '/checkout.php?fresh=1' });
        await server.inject({ ...browserRequest, url: '/checkout.php?fresh=1' });

        expect(axiosMock.history.get).toHaveLength(1);
    });

    it('should fetch from the store again once the configured TTL has elapsed', async () => {
        await server.inject({ ...browserRequest, url: '/checkout.php?fresh=2' });
        await sleep(cacheTTL * 1.5);
        await server.inject({ ...browserRequest, url: '/checkout.php?fresh=2' });

        expect(axiosMock.history.get).toHaveLength(2);
    });
});
