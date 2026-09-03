import 'colors';
import StencilConfigManager from './StencilConfigManager.js';
import themeApiClientModule from './theme-api-client.js';
import storeSettingsApiClientModule from './store-settings-api-client.js';
import stencilPushUtilsModule from './stencil-push.utils.js';

/**
 * Setup shared by the CLI commands which boot the local server (`start` and `serve`).
 *
 * The commands differ in whether they may talk to the user: `start` runs in a terminal and
 * can prompt for a channel, `serve` runs unattended and must fail instead. That difference
 * is the `interactive` flag on resolveChannelUrl/prepare; everything else is common.
 */
class StencilBootstrap {
    constructor({
        themeApiClient = themeApiClientModule,
        storeSettingsApiClient = storeSettingsApiClientModule,
        stencilConfigManager = new StencilConfigManager(),
        stencilPushUtils = stencilPushUtilsModule,
        logger = console,
    } = {}) {
        this._themeApiClient = themeApiClient;
        this._storeSettingsApiClient = storeSettingsApiClient;
        this._stencilConfigManager = stencilConfigManager;
        this._stencilPushUtils = stencilPushUtils;
        this._logger = logger;
    }

    /**
     * @returns {Promise<object>}
     */
    async readConfig() {
        return this._stencilConfigManager.read();
    }

    /**
     * @param {object} stencilConfig
     * @returns {Promise<string>}
     */
    async resolveStoreHash(stencilConfig) {
        return this._themeApiClient.getStoreHash({ storeUrl: stencilConfig.normalStoreUrl });
    }

    /**
     * Resolves the storefront url to proxy against.
     *
     * Precedence: an explicit --channelUrl wins outright (and skips the channels lookup),
     * then --channelId, then either a prompt or an error depending on `interactive`.
     *
     * @param {object} stencilConfig
     * @param {object} cliOptions
     * @param {object} options
     * @param {boolean} [options.interactive] - whether the user may be prompted
     * @param {string} options.storeHash
     * @returns {Promise<string>}
     */
    async resolveChannelUrl(stencilConfig, cliOptions, { interactive = true, storeHash } = {}) {
        if (cliOptions.channelUrl) {
            return cliOptions.channelUrl;
        }
        const { accessToken } = stencilConfig;
        const apiHost = cliOptions.apiHost || stencilConfig.apiHost;
        const channels = await this._themeApiClient.getStoreChannels({
            storeHash,
            accessToken,
            apiHost,
        });
        const channelId = cliOptions.channelId
            ? cliOptions.channelId
            : await this._selectChannelId(channels, interactive);
        const foundChannel = channels.find(
            (channel) => channel.channel_id === parseInt(channelId, 10),
        );
        if (!foundChannel) {
            throw new Error(
                `Channel ${String(channelId).cyan} was not found on this store.\n`.red +
                    this._describeChannels(channels),
            );
        }
        return foundChannel.url;
    }

    /**
     * @private
     * @param {Array<{channel_id: number, url: string}>} channels
     * @param {boolean} interactive
     * @returns {Promise<number>}
     */
    async _selectChannelId(channels, interactive) {
        if (!channels || channels.length === 0) {
            throw new Error(
                'No storefront channels were found on this store. '.red +
                    'A channel is required to serve a theme.'.red,
            );
        }
        // A single channel is unambiguous, so it needs neither a prompt nor a flag.
        // This matches promptUserToSelectChannel's own behaviour for one channel.
        if (channels.length === 1) {
            return channels[0].channel_id;
        }
        if (!interactive) {
            throw new Error(
                'This store has more than one storefront channel, so one must be chosen explicitly.\n'
                    .red +
                    `Pass ${'--channelId <id>'.cyan} or ${'--channelUrl <url>'.cyan}.\n\n` +
                    this._describeChannels(channels),
            );
        }
        return this._stencilPushUtils.promptUserToSelectChannel(channels);
    }

    /**
     * @private
     * @param {Array<{channel_id: number, url: string}>} channels
     * @returns {string}
     */
    _describeChannels(channels) {
        if (!channels || channels.length === 0) {
            return 'No channels are available on this store.';
        }
        const rows = channels
            .map((channel) => `  ${String(channel.channel_id).cyan}  ${channel.url}`)
            .join('\n');
        return `Available channels:\n${rows}`;
    }

    /**
     * Verifies the CLI version against the store and returns the store's canonical urls.
     *
     * @param {string} channelUrl
     * @returns {Promise<{sslUrl: string, baseUrl: string}>}
     */
    async checkVersion(channelUrl) {
        return this._themeApiClient.checkCliVersion({ storeUrl: channelUrl });
    }

    /**
     * @param {object} stencilConfig
     * @param {object} cliOptions
     * @param {string} storeHash
     * @returns {Promise<object>}
     */
    async fetchStoreLocale(stencilConfig, cliOptions, storeHash) {
        const { accessToken } = stencilConfig;
        const apiHost = cliOptions.apiHost || stencilConfig.apiHost;
        return this._storeSettingsApiClient.getStoreSettingsLocale({
            storeHash,
            accessToken,
            apiHost,
        });
    }

    /**
     * Runs the whole setup sequence and returns everything the local server needs.
     *
     * @param {object} cliOptions
     * @param {object} [options]
     * @param {boolean} [options.interactive]
     * @returns {Promise<{stencilConfig: object, storeHash: string, channelUrl: string, storeSettingsLocale: object, port: number}>}
     */
    async prepare(cliOptions, { interactive = true } = {}) {
        const stencilConfig = await this.readConfig();
        const port = cliOptions.port || stencilConfig.port;
        const storeHash = await this.resolveStoreHash(stencilConfig);
        const channelUrl = await this.resolveChannelUrl(stencilConfig, cliOptions, {
            interactive,
            storeHash,
        });
        const storeInfoFromAPI = await this.checkVersion(channelUrl);
        const storeSettingsLocale = await this.fetchStoreLocale(
            stencilConfig,
            cliOptions,
            storeHash,
        );
        return {
            stencilConfig: {
                ...stencilConfig,
                storeUrl: storeInfoFromAPI.sslUrl,
                normalStoreUrl: storeInfoFromAPI.baseUrl,
                port,
            },
            storeHash,
            channelUrl,
            storeSettingsLocale,
            port,
        };
    }
}
export default StencilBootstrap;
