import * as Hapi from '@hapi/hapi';
import * as inert from '@hapi/inert';
import * as h2o2 from '@hapi/h2o2';
import router from './router.module';

describe('Router', () => {
    const SERVER_OPTIONS = {
        port: 3000,
    };
    const ROUTER_OPTIONS = {
        storeUrl: 'https://store-abc124.mybigcommerce.com',
        normalStoreUrl: 'http://s1234567890.mybigcommerce.com',
        port: SERVER_OPTIONS.port,
    };
    const server = new Hapi.Server(SERVER_OPTIONS);
    const RendererPluginMock = {
        register(_server) {
            _server.expose('implementation', (request, h) => h.response('RendererHandlerFired'));
        },
        name: 'Renderer',
        version: '0.0.1',
    };
    const ThemeAssetsMock = {
        register(_server) {
            _server.expose('cssHandler', (request, h) => h.response('CssHandlerFired'));
            _server.expose('assetHandler', (request, h) => h.response('assetHandlerFired'));
        },
        name: 'ThemeAssets',
        version: '0.0.1',
    };
    beforeAll(async () => {
        await server.register([
            inert,
            h2o2,
            RendererPluginMock,
            ThemeAssetsMock,
            { plugin: router, options: ROUTER_OPTIONS },
        ]);
        await server.start();
    });
    afterAll(async () => {
        await server.stop();
    });
    it('should call the Renderer handler', async () => {
        const options = {
            method: 'GET',
            url: '/test',
        };
        const response = await server.inject(options);
        expect(response.statusCode).toEqual(200);
        expect(response.payload).toEqual('RendererHandlerFired');
    });
    it('should call the CSS handler', async () => {
        const options = {
            method: 'GET',
            url: '/stencil/123/css/file.css',
        };
        const response = await server.inject(options);
        expect(response.statusCode).toEqual(200);
        expect(response.payload).toEqual('CssHandlerFired');
    });
    it('should call the assets handler', async () => {
        const options = {
            method: 'GET',
            url: '/stencil/123/js/file.js',
        };
        const response = await server.inject(options);
        expect(response.statusCode).toEqual(200);
        expect(response.payload).toEqual('assetHandlerFired');
    });
    it('should inject host and origin headers for GraphQL requests', async () => {
        const options = {
            method: 'POST',
            url: '/graphql',
            headers: { authorization: 'auth123' },
        };
        const response = await server.inject(options);
        expect(response.request.payload.headers).toMatchObject({
            authorization: 'auth123',
            origin: 'https://store-abc124.mybigcommerce.com',
            host: 'store-abc124.mybigcommerce.com',
        });
    });
    it('should not register the health route by default', async () => {
        const response = await server.inject({ method: 'GET', url: '/_stencil/health' });
        // Falls through to the renderer catch-all rather than being handled directly.
        expect(response.payload).toEqual('RendererHandlerFired');
    });
});

describe('Router with the health check enabled', () => {
    // A separate server instance is required: the plugin keeps its options on a module-level
    // `internals` singleton, and routes are fixed per server at initialisation time.
    const server = new Hapi.Server({ port: 3001 });
    const RendererPluginMock = {
        register(_server) {
            _server.expose('implementation', (request, h) => h.response('RendererHandlerFired'));
        },
        name: 'Renderer',
        version: '0.0.1',
    };
    const ThemeAssetsMock = {
        register(_server) {
            _server.expose('cssHandler', (request, h) => h.response('CssHandlerFired'));
            _server.expose('assetHandler', (request, h) => h.response('assetHandlerFired'));
        },
        name: 'ThemeAssets',
        version: '0.0.1',
    };
    beforeAll(async () => {
        await server.register([
            inert,
            h2o2,
            RendererPluginMock,
            ThemeAssetsMock,
            {
                plugin: router,
                options: {
                    storeUrl: 'https://store-abc124.mybigcommerce.com',
                    normalStoreUrl: 'http://s1234567890.mybigcommerce.com',
                    port: 3001,
                    healthCheckEnabled: true,
                },
            },
        ]);
        await server.start();
    });
    afterAll(async () => {
        await server.stop();
    });
    it('should answer the health route without reaching the renderer', async () => {
        const response = await server.inject({ method: 'GET', url: '/_stencil/health' });
        expect(response.statusCode).toEqual(200);
        expect(response.result).toEqual({ status: 'ok' });
    });
    it('should still route other paths to the renderer', async () => {
        const response = await server.inject({ method: 'GET', url: '/some-page' });
        expect(response.payload).toEqual('RendererHandlerFired');
    });
});
