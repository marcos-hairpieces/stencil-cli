#!/usr/bin/env node
import 'colors';
import { PACKAGE_INFO } from '../constants.js';
import program from '../lib/commander.js';
import StencilServe from '../lib/StencilServe.js';
import { printCliResultErrorAndExit, prepareCommand } from '../lib/cliCommon.js';

program
    .version(PACKAGE_INFO.version)
    .option('-p, --port [port]', 'Set port number to listen on')
    .option('--bind [address]', 'Set the address to listen on. Default is 0.0.0.0 (all interfaces)')
    .option('-c, --channelId [channelId]', 'Set the channel id for the storefront', parseInt)
    .option(
        '-cu, --channelUrl [channelUrl]',
        'Set a custom domain url to bypass dns/proxy protection',
    )
    .option('-v, --variation [name]', 'Set which theme variation to serve')
    .option(
        '-n, --no-cache',
        'Turns off caching for API resource data per storefront page. The cache lasts for 5 minutes before automatically refreshing.',
    )
    .option(
        '--cache-ttl [seconds]',
        'How long storefront API responses are cached per page. Default is 15',
        parseInt,
    )
    .option('--build', "Run the theme's production build task once before serving")
    .option('-t, --timeout [timeout]', 'Timeout in seconds for --build. Default is 60', '60')
    .option(
        '--precompile-css',
        'Compile the theme stylesheets into .stencil-css for a container image and exit, without serving. ' +
            'The server loads them at startup while the stylesheets and theme settings still match',
    );
const cliOptions = prepareCommand(program);
const options = {
    port: cliOptions.port,
    bind: cliOptions.bind,
    channelId: cliOptions.channelId,
    channelUrl: cliOptions.channelUrl,
    variation: cliOptions.variation,
    apiHost: cliOptions.host,
    cache: cliOptions.cache,
    cacheTtl: cliOptions.cacheTtl,
    build: cliOptions.build,
    timeout: cliOptions.timeout,
};
if (cliOptions.precompileCss) {
    new StencilServe().precompileCss(options).catch(printCliResultErrorAndExit);
} else {
    new StencilServe().run(options).catch(printCliResultErrorAndExit);
}
