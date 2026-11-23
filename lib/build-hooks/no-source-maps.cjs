/**
 * Preloaded (`node --require`) into the theme build worker for preview builds. Turns off
 * webpack source maps without touching the theme's own build configuration.
 *
 * Every `require('webpack')` gets the real webpack wrapped so that each config it is called
 * with has `devtool: false`. In webpack 4 the default minimizer only produces source maps when
 * `devtool` asks for them, so the minified code is unchanged and only the .map files (and the
 * sourceMappingURL comment pointing at them) are left out. Themes that already build without
 * source maps are unaffected.
 */
const Module = require('module');

// Module._load is Node's own (undocumented but stable) loader entry point.
// eslint-disable-next-line no-underscore-dangle
const originalLoad = Module._load;
const wrapped = new WeakMap();

const withoutSourceMaps = (config) => {
    if (Array.isArray(config)) {
        return config.map(withoutSourceMaps);
    }
    if (config && typeof config === 'object' && config.devtool) {
        return { ...config, devtool: false };
    }
    return config;
};

// eslint-disable-next-line no-underscore-dangle
Module._load = function load(request, parent, isMain) {
    const exported = originalLoad.call(this, request, parent, isMain);
    if (request !== 'webpack' || typeof exported !== 'function') {
        return exported;
    }
    if (!wrapped.has(exported)) {
        // A Proxy keeps every property of the webpack export (plugins, optimize, version and
        // webpack 4's lazy getters) and only changes what calling it does.
        wrapped.set(
            exported,
            new Proxy(exported, {
                apply(target, thisArg, [config, ...rest]) {
                    return Reflect.apply(target, thisArg, [withoutSourceMaps(config), ...rest]);
                },
            }),
        );
    }
    return wrapped.get(exported);
};
