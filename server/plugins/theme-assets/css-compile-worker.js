/**
 * Child process that compiles theme stylesheets for `stencil serve`.
 *
 * node-sass is native code: memory it takes while compiling stays with the process after the
 * compile finishes, roughly 200 MB for a large theme. Compiling here and exiting returns all
 * of it to the operating system, so the long-running server never loads the compiler at all.
 *
 * Receives one message, { themePath, jobs: [{ variationIndex, fileName }] }, sends one
 * { index, css } or { index, error } message per job in order, then exits.
 */
import cssCompiler from '../../../lib/css/compile.js';
import ThemeConfig from '../../../lib/theme-config.js';

const send = (message) =>
    new Promise((resolve) => {
        process.send(message, resolve);
    });

process.once('message', async ({ themePath, jobs }) => {
    const assetsPath = `${themePath}/assets`;
    for (const [index, { variationIndex, fileName }] of jobs.entries()) {
        try {
            const themeConfig = ThemeConfig.create(themePath);
            themeConfig.setVariation(variationIndex);
            // eslint-disable-next-line no-await-in-loop
            const configuration = await themeConfig.getConfig();
            // eslint-disable-next-line no-await-in-loop
            const css = await cssCompiler.compile(
                configuration,
                assetsPath,
                fileName,
                cssCompiler.SASS_ENGINE_NAME,
                { sourceMap: false },
            );
            // eslint-disable-next-line no-await-in-loop
            await send({ index, css });
        } catch (err) {
            // node-sass errors carry the readable location in `formatted`.
            // eslint-disable-next-line no-await-in-loop
            await send({ index, error: (err && (err.formatted || err.message)) || String(err) });
        }
    }
    // Closing the channel leaves nothing to keep the process alive, so it exits.
    process.disconnect();
});
