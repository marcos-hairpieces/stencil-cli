import { jest } from '@jest/globals';
import StencilServe from './StencilServe.js';

afterAll(() => jest.restoreAllMocks());

describe('StencilServe unit tests', () => {
    const getContextStub = () => ({
        stencilConfig: {
            accessToken: 'accessToken_value',
            storeUrl: 'https://example.com',
            normalStoreUrl: 'http://example.com',
            port: 3000,
        },
        storeHash: 'storeHash_value',
        channelUrl: 'https://example.com',
        storeSettingsLocale: { default_shopper_language: 'en_US' },
        port: 3000,
    });
    const getBootstrapStub = (context = getContextStub()) => ({
        prepare: jest.fn().mockResolvedValue(context),
    });
    const getServerStub = () => ({ stop: jest.fn().mockResolvedValue(undefined) });
    const getServerModuleStub = (server = getServerStub()) => ({
        create: jest.fn().mockResolvedValue(server),
    });
    const getThemeConfigManagerStub = () => ({
        themePath: '/some/theme/path',
        configPath: '/some/theme/path/config.json',
        variationIndex: 0,
        setVariationByName: jest.fn(),
    });
    const getFsUtilsStub = (existsSync = () => true) => ({
        existsSync: jest.fn(existsSync),
    });
    const getCliCommonStub = () => ({ checkNodeVersion: jest.fn() });
    const getLoggerStub = () => ({ log: jest.fn(), error: jest.fn() });
    const getProcessStub = () => ({ on: jest.fn(), exit: jest.fn() });
    const getBuildConfigManagerStub = ({ error } = {}) => {
        const instance = {
            initConfig: jest.fn().mockResolvedValue(undefined),
            production: jest.fn((callback) => callback(error)),
            initWorker: jest.fn(),
        };
        instance.initWorker.mockReturnValue(instance);
        const BuildConfigManager = jest.fn().mockImplementation(() => instance);
        return { BuildConfigManager, instance };
    };
    const createInstance = ({
        bootstrap,
        themeConfigManager,
        BuildConfigManager,
        serverModule,
        fsUtils,
        cliCommon,
        logger,
        processRef,
    } = {}) => {
        const passedArgs = {
            bootstrap: bootstrap || getBootstrapStub(),
            themeConfigManager: themeConfigManager || getThemeConfigManagerStub(),
            BuildConfigManager:
                BuildConfigManager || getBuildConfigManagerStub().BuildConfigManager,
            serverModule: serverModule || getServerModuleStub(),
            fsUtils: fsUtils || getFsUtilsStub(),
            cliCommon: cliCommon || getCliCommonStub(),
            logger: logger || getLoggerStub(),
            processRef: processRef || getProcessStub(),
        };
        return { passedArgs, instance: new StencilServe(passedArgs) };
    };

    describe('constructor', () => {
        it('should create an instance without options parameters passed', () => {
            expect(new StencilServe()).toBeInstanceOf(StencilServe);
        });
    });

    describe('run', () => {
        it('should prepare the bootstrap non-interactively so it can never prompt', async () => {
            const bootstrap = getBootstrapStub();
            const { instance } = createInstance({ bootstrap });

            await instance.run({});

            expect(bootstrap.prepare).toHaveBeenCalledWith({}, { interactive: false });
        });

        it('should bind the requested port directly and disable the development affordances', async () => {
            const serverModule = getServerModuleStub();
            const { instance } = createInstance({ serverModule });

            await instance.run({});

            expect(serverModule.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    portOffset: 0,
                    showLogo: false,
                    debugQueriesEnabled: false,
                    inDevelopment: false,
                    healthCheckEnabled: true,
                }),
            );
        });

        it('should pass the theme path, cache setting and locale through to the server', async () => {
            const serverModule = getServerModuleStub();
            const { instance } = createInstance({ serverModule });

            await instance.run({ cache: false });

            expect(serverModule.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    themePath: '/some/theme/path',
                    useCache: false,
                    storeSettingsLocale: { default_shopper_language: 'en_US' },
                }),
            );
        });

        it('should apply a requested theme variation', async () => {
            const themeConfigManager = getThemeConfigManagerStub();
            const { instance } = createInstance({ themeConfigManager });

            await instance.run({ variation: 'light' });

            expect(themeConfigManager.setVariationByName).toHaveBeenCalledWith('light');
        });

        it('should throw when --variation is passed without a value', async () => {
            const { instance } = createInstance();

            await expect(instance.run({ variation: true })).rejects.toThrow(
                'You have to specify a value for -v or --variation',
            );
        });

        it('should throw when the theme has no config.json', async () => {
            const { instance } = createInstance({ fsUtils: getFsUtilsStub(() => false) });

            await expect(instance.run({})).rejects.toThrow('config.json');
        });

        it('should register shutdown handlers for SIGTERM and SIGINT', async () => {
            const processRef = getProcessStub();
            const { instance } = createInstance({ processRef });

            await instance.run({});

            expect(processRef.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(processRef.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        });
    });

    describe('build behaviour', () => {
        it('should never construct a BuildConfigManager when --build is not passed', async () => {
            const { BuildConfigManager } = getBuildConfigManagerStub();
            const { instance } = createInstance({ BuildConfigManager });

            await instance.run({});

            // Constructing one downloads Cornerstone's stencil.conf.cjs from GitHub and writes
            // it into the theme when absent, which must not happen on a read-only deployment.
            expect(BuildConfigManager).not.toHaveBeenCalled();
        });

        it('should run the production task once when --build is passed', async () => {
            const { BuildConfigManager, instance: buildConfig } = getBuildConfigManagerStub();
            const { instance } = createInstance({ BuildConfigManager });

            await instance.run({ build: true, timeout: '30' });

            expect(BuildConfigManager).toHaveBeenCalledWith({ timeout: 30000 });
            expect(buildConfig.initConfig).toHaveBeenCalledTimes(1);
            expect(buildConfig.production).toHaveBeenCalledTimes(1);
        });

        it('should surface a string-valued build failure as an Error', async () => {
            const { BuildConfigManager } = getBuildConfigManagerStub({
                error: 'worker timed out',
            });
            const { instance } = createInstance({ BuildConfigManager });

            await expect(instance.run({ build: true })).rejects.toThrow('worker timed out');
        });

        it('should not start the server when the build fails', async () => {
            const { BuildConfigManager } = getBuildConfigManagerStub({
                error: 'worker timed out',
            });
            const serverModule = getServerModuleStub();
            const { instance } = createInstance({ BuildConfigManager, serverModule });

            await expect(instance.run({ build: true })).rejects.toThrow();
            expect(serverModule.create).not.toHaveBeenCalled();
        });

        it('should warn when the theme has a build config but no built assets', async () => {
            const logger = getLoggerStub();
            const fsUtils = getFsUtilsStub((filePath) => !filePath.includes('assets/dist'));
            const { instance } = createInstance({ logger, fsUtils });

            await instance.run({});

            expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('assets/dist'));
        });
    });

    describe('shutdown', () => {
        it('should drain the server and exit cleanly', async () => {
            const server = getServerStub();
            const processRef = getProcessStub();
            const { instance } = createInstance({
                serverModule: getServerModuleStub(server),
                processRef,
            });

            await instance.run({});
            await instance.shutdown('SIGTERM');

            expect(server.stop).toHaveBeenCalledWith({ timeout: 10000 });
            expect(processRef.exit).toHaveBeenCalledWith(0);
        });

        it('should ignore a second signal received while already shutting down', async () => {
            const server = getServerStub();
            const { instance } = createInstance({
                serverModule: getServerModuleStub(server),
            });

            await instance.run({});
            await instance.shutdown('SIGTERM');
            await instance.shutdown('SIGINT');

            expect(server.stop).toHaveBeenCalledTimes(1);
        });

        it('should exit non-zero when draining fails', async () => {
            const server = { stop: jest.fn().mockRejectedValue(new Error('stop failed')) };
            const processRef = getProcessStub();
            const { instance } = createInstance({
                serverModule: getServerModuleStub(server),
                processRef,
            });

            await instance.run({});
            await instance.shutdown('SIGTERM');

            expect(processRef.exit).toHaveBeenCalledWith(1);
        });
    });

    describe('startLocalServer', () => {
        it('should give a readable message when the port is already in use', async () => {
            const serverModule = {
                create: jest
                    .fn()
                    .mockRejectedValue(
                        Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
                    ),
            };
            const { instance } = createInstance({ serverModule });

            await expect(instance.run({})).rejects.toThrow('already in use');
        });
    });
});
