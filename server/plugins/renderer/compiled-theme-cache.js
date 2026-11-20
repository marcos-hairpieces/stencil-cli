import { promisify } from 'util';
import { mapValues } from 'lodash-es';
import Translator from '@bigcommerce/stencil-paper/lib/translator/index.js';
import templateAssembler from '../../../lib/template-assembler.js';
import langAssembler from '../../../lib/lang-assembler.js';

// Must match the options stencil-paper-handlebars precompiles with, or the cached output would
// render differently from an uncached render.
const PRECOMPILE_OPTIONS = { preventIndent: true };
const FRONTMATTER_REGEX = /---\r?\n[\S\s]*\r?\n---\r?\n([\S\s]*)$/;
// Accept-Language values are client supplied; bound how many distinct translators are kept.
const MAX_TRANSLATORS = 50;

const assembleTemplates = promisify(templateAssembler.assemble);
const assembleTranslations = promisify(langAssembler.assemble);
const loadThemeTranslations = async () =>
    mapValues(await assembleTranslations(), (locale) => JSON.parse(locale));

/**
 * Removes the frontmatter block from a top-level template, as stencil-paper's default
 * assembler does. Partials keep theirs.
 *
 * @param {string} source
 * @returns {string}
 */
const stripFrontmatter = (source) => {
    const match = source.match(FRONTMATTER_REGEX);
    return match && match[1] ? match[1] : source;
};

/**
 * Memoises an async computation per key. A rejected computation is evicted so the next call
 * retries instead of replaying the failure forever.
 *
 * @param {Map} map
 * @param {*} key
 * @param {function(): Promise} compute
 * @returns {Promise}
 */
const memo = (map, key, compute) => {
    let promise = map.get(key);
    if (!promise) {
        promise = compute();
        map.set(key, promise);
        promise.catch(() => map.delete(key));
    }
    return promise;
};

/**
 * Template, translation and frontmatter cache for a theme whose files cannot change while the
 * server runs (`stencil serve`).
 *
 * The default render path reads every template a page needs from disk, runs each one through
 * the Handlebars compiler and evaluates the result, then builds a new translator, on every
 * request. With an immutable theme all of that is pure, so this does it once: the Handlebars
 * template specs are compiled once per template and shared by every request, which only has
 * to bind them to its own Handlebars environment (a cheap step that keeps per-request helper
 * state, such as the store settings, isolated).
 */
class CompiledThemeCache {
    /**
     * @param {string} templatesFolder - absolute path to the theme's templates directory
     * @param {object} [options]
     * @param {function(): Promise<Object<string, object>>} [options.loadTranslations] - reads
     *   the theme's translations keyed by lower-cased locale; defaults to the lang directory
     */
    constructor(templatesFolder, { loadTranslations = loadThemeTranslations } = {}) {
        this._templatesFolder = templatesFolder;
        this._loadTranslations = loadTranslations;
        // `${handlebars version}\0${root|partial}\0${name}` -> template spec
        this._specs = new Map();
        // `${handlebars version}\0${root path}` -> Promise<{[name]: template spec}>
        this._pageSpecs = new Map();
        // root path -> template source, for the frontmatter the renderer reads
        this._rawTemplates = new Map();
        this._translations = new Map();
        this._translators = new Map();
    }

    /**
     * Returns the compiled specs of a top-level template and every partial it pulls in.
     *
     * @param {string} rootPath - template path relative to the templates folder
     * @param {object} handlebars - the Handlebars environment the specs will be bound to;
     *   only its version and compiler are used, so any environment of that version works
     * @returns {Promise<Object<string, object>>}
     */
    getTemplateSpecs(rootPath, handlebars) {
        return memo(this._pageSpecs, `${handlebars.VERSION}\0${rootPath}`, async () => {
            const sources = await assembleTemplates(this._templatesFolder, rootPath);
            const specs = {};
            for (const [name, source] of Object.entries(sources)) {
                specs[name] = this._getSpec(handlebars, name, name === rootPath, source);
            }
            return specs;
        });
    }

    /**
     * @private
     */
    _getSpec(handlebars, name, isRoot, source) {
        const key = `${handlebars.VERSION}\0${isRoot ? 'root' : 'partial'}\0${name}`;
        let spec = this._specs.get(key);
        if (!spec) {
            const precompiled = handlebars.precompile(
                isRoot ? stripFrontmatter(source) : source,
                PRECOMPILE_OPTIONS,
            );
            // The precompiler's output is JavaScript source for an object literal; turning it
            // back into an object is what stencil-paper-handlebars does with eval.
            // eslint-disable-next-line no-new-func
            spec = new Function(`return ${precompiled};`)();
            this._specs.set(key, spec);
        }
        return spec;
    }

    /**
     * @returns {Promise<Object<string, object>>} translations keyed by lower-cased locale
     */
    getTranslations() {
        return memo(this._translations, 'all', () => this._loadTranslations());
    }

    /**
     * Returns a translator for the Accept-Language value. Translators compile each message
     * format the first time it is used, so reusing one per language keeps that work too.
     *
     * @param {string} acceptLanguage
     * @param {object} logger
     * @returns {Promise<Translator>}
     */
    async getTranslator(acceptLanguage, logger = console) {
        const cached = this._translators.get(acceptLanguage);
        if (cached) {
            return cached;
        }
        const translator = Translator.create(acceptLanguage, await this.getTranslations(), logger);
        if (this._translators.size >= MAX_TRANSLATORS) {
            this._translators.delete(this._translators.keys().next().value);
        }
        this._translators.set(acceptLanguage, translator);
        return translator;
    }

    /**
     * @param {string} templatePath - template path relative to the templates folder
     * @returns {string} the raw template source, frontmatter included
     */
    getTemplateContentSync(templatePath) {
        let content = this._rawTemplates.get(templatePath);
        if (content === undefined) {
            content = templateAssembler.getTemplateContentSync(this._templatesFolder, templatePath);
            this._rawTemplates.set(templatePath, content);
        }
        return content;
    }
}

export default CompiledThemeCache;
