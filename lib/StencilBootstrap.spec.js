import { jest } from '@jest/globals';
import StencilBootstrap from './StencilBootstrap.js';

afterAll(() => jest.restoreAllMocks());

describe('StencilBootstrap unit tests', () => {
    const storeHash = 'storeHash_value';
    const accessToken = 'accessToken_value';
    const apiHost = 'apiHost_value';
    const stencilConfig = { accessToken, normalStoreUrl: 'https://example.com' };
    const singleChannel = [{ channel_id: 5, url: 'https://one.example.com' }];
    const multipleChannels = [
        { channel_id: 5, url: 'https://one.example.com' },
        { channel_id: 6, url: 'https://two.example.com' },
    ];
    const getThemeApiClientStub = (channels = singleChannel) => ({
        getStoreHash: jest.fn().mockResolvedValue(storeHash),
        getStoreChannels: jest.fn().mockResolvedValue(channels),
        checkCliVersion: jest.fn().mockResolvedValue({
            baseUrl: 'http://example.com',
            sslUrl: 'https://example.com',
        }),
    });
    const getStoreSettingsApiClientStub = () => ({
        getStoreSettingsLocale: jest.fn().mockResolvedValue({ default_shopper_language: 'en_US' }),
    });
    const getStencilPushUtilsStub = () => ({
        promptUserToSelectChannel: jest.fn().mockResolvedValue(6),
    });
    const getStencilConfigManagerStub = (config = stencilConfig) => ({
        read: jest.fn().mockResolvedValue(config),
    });
    const createInstance = ({
        themeApiClient,
        storeSettingsApiClient,
        stencilPushUtils,
        stencilConfigManager,
    } = {}) => {
        const passedArgs = {
            themeApiClient: themeApiClient || getThemeApiClientStub(),
            storeSettingsApiClient: storeSettingsApiClient || getStoreSettingsApiClientStub(),
            stencilPushUtils: stencilPushUtils || getStencilPushUtilsStub(),
            stencilConfigManager: stencilConfigManager || getStencilConfigManagerStub(),
            logger: { log: jest.fn(), error: jest.fn() },
        };
        return { passedArgs, instance: new StencilBootstrap(passedArgs) };
    };

    describe('constructor', () => {
        it('should create an instance without options parameters passed', () => {
            expect(new StencilBootstrap()).toBeInstanceOf(StencilBootstrap);
        });
    });

    describe('resolveChannelUrl', () => {
        it('should return channelUrl from the CLI without looking up channels', async () => {
            const themeApiClient = getThemeApiClientStub();
            const { instance } = createInstance({ themeApiClient });
            const channelUrl = 'https://shop.bigcommerce.com';

            const result = await instance.resolveChannelUrl(
                stencilConfig,
                { apiHost, channelUrl },
                { storeHash },
            );

            expect(result).toEqual(channelUrl);
            expect(themeApiClient.getStoreChannels).not.toHaveBeenCalled();
        });

        it('should use the channel matching an explicit channelId', async () => {
            const { instance } = createInstance({
                themeApiClient: getThemeApiClientStub(multipleChannels),
            });

            const result = await instance.resolveChannelUrl(
                stencilConfig,
                { apiHost, channelId: 6 },
                { storeHash },
            );

            expect(result).toEqual('https://two.example.com');
        });

        it('should auto-select the only channel when the store has exactly one', async () => {
            const stencilPushUtils = getStencilPushUtilsStub();
            const { instance } = createInstance({ stencilPushUtils });

            const result = await instance.resolveChannelUrl(
                stencilConfig,
                { apiHost },
                { interactive: false, storeHash },
            );

            expect(result).toEqual('https://one.example.com');
            expect(stencilPushUtils.promptUserToSelectChannel).not.toHaveBeenCalled();
        });

        it('should prompt when interactive and the channel is ambiguous', async () => {
            const stencilPushUtils = getStencilPushUtilsStub();
            const { instance } = createInstance({
                themeApiClient: getThemeApiClientStub(multipleChannels),
                stencilPushUtils,
            });

            const result = await instance.resolveChannelUrl(
                stencilConfig,
                { apiHost },
                { interactive: true, storeHash },
            );

            expect(stencilPushUtils.promptUserToSelectChannel).toHaveBeenCalledTimes(1);
            expect(result).toEqual('https://two.example.com');
        });

        it('should throw instead of prompting when not interactive and the channel is ambiguous', async () => {
            const stencilPushUtils = getStencilPushUtilsStub();
            const { instance } = createInstance({
                themeApiClient: getThemeApiClientStub(multipleChannels),
                stencilPushUtils,
            });

            await expect(
                instance.resolveChannelUrl(
                    stencilConfig,
                    { apiHost },
                    { interactive: false, storeHash },
                ),
            ).rejects.toThrow('more than one storefront channel');
            expect(stencilPushUtils.promptUserToSelectChannel).not.toHaveBeenCalled();
        });

        it('should list the available channels when it cannot choose one', async () => {
            const { instance } = createInstance({
                themeApiClient: getThemeApiClientStub(multipleChannels),
            });

            await expect(
                instance.resolveChannelUrl(
                    stencilConfig,
                    { apiHost },
                    { interactive: false, storeHash },
                ),
            ).rejects.toThrow('https://two.example.com');
        });

        it('should throw a named error when the requested channelId does not exist', async () => {
            const { instance } = createInstance({
                themeApiClient: getThemeApiClientStub(multipleChannels),
            });

            await expect(
                instance.resolveChannelUrl(
                    stencilConfig,
                    { apiHost, channelId: 999 },
                    { storeHash },
                ),
            ).rejects.toThrow('was not found on this store');
        });

        it('should throw when the store has no channels', async () => {
            const { instance } = createInstance({ themeApiClient: getThemeApiClientStub([]) });

            await expect(
                instance.resolveChannelUrl(
                    stencilConfig,
                    { apiHost },
                    { interactive: false, storeHash },
                ),
            ).rejects.toThrow('No storefront channels');
        });
    });

    describe('prepare', () => {
        it('should return the server context with urls from the version check', async () => {
            const { instance } = createInstance({
                stencilConfigManager: getStencilConfigManagerStub({
                    ...stencilConfig,
                    port: 3000,
                }),
            });

            const result = await instance.prepare({ apiHost }, { interactive: false });

            expect(result.storeHash).toEqual(storeHash);
            expect(result.channelUrl).toEqual('https://one.example.com');
            expect(result.port).toEqual(3000);
            expect(result.stencilConfig).toMatchObject({
                storeUrl: 'https://example.com',
                normalStoreUrl: 'http://example.com',
                port: 3000,
            });
            expect(result.storeSettingsLocale).toEqual({ default_shopper_language: 'en_US' });
        });

        it('should prefer the port from the CLI over the config file', async () => {
            const { instance } = createInstance({
                stencilConfigManager: getStencilConfigManagerStub({
                    ...stencilConfig,
                    port: 3000,
                }),
            });

            const result = await instance.prepare({ apiHost, port: 4000 }, { interactive: false });

            expect(result.port).toEqual(4000);
            expect(result.stencilConfig.port).toEqual(4000);
        });

        it('should resolve the store hash before the channel url so the locale lookup can use it', async () => {
            const themeApiClient = getThemeApiClientStub();
            const storeSettingsApiClient = getStoreSettingsApiClientStub();
            const { instance } = createInstance({ themeApiClient, storeSettingsApiClient });

            await instance.prepare({ apiHost }, { interactive: false });

            expect(themeApiClient.getStoreHash).toHaveBeenCalledTimes(1);
            expect(storeSettingsApiClient.getStoreSettingsLocale).toHaveBeenCalledWith(
                expect.objectContaining({ storeHash }),
            );
        });
    });
});
