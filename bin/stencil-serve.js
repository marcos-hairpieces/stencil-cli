#!/usr/bin/env node
import 'colors';
import { PACKAGE_INFO } from '../constants.js';
import program from '../lib/commander.js';
import StencilServe from '../lib/StencilServe.js';
import { printCliResultErrorAndExit, prepareCommand } from '../lib/cliCommon.js';

program
    .version(PACKAGE_INFO.version)
    .option('-p, --port [port]', 'Set port number to listen on')
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
    .option('--build', "Run the theme's production build task once before serving")
    .option('-t, --timeout [timeout]', 'Timeout in seconds for --build. Default is 60', '60');
const cliOptions = prepareCommand(program);
const options = {
    port: cliOptions.port,
    channelId: cliOptions.channelId,
    channelUrl: cliOptions.channelUrl,
    variation: cliOptions.variation,
    apiHost: cliOptions.host,
    cache: cliOptions.cache,
    build: cliOptions.build,
    timeout: cliOptions.timeout,
};
new StencilServe().run(options).catch(printCliResultErrorAndExit);
