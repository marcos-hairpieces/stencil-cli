import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import Paper from '@bigcommerce/stencil-paper';
import { jest } from '@jest/globals';
import CompiledThemeCache from './compiled-theme-cache.js';
import PencilResponse from './responses/pencil-response.js';
import templateAssembler from '../../../lib/template-assembler.js';

const translations = {
    en: { greeting: 'Hello' },
    fr: { greeting: 'Bonjour' },
};

const templates = {
    'pages/home.html': `---
products:
    featured: 4
---
<h1>{{lang 'greeting'}}</h1>
<img src="{{cdn '/img/logo.png'}}">
{{> components/card}}
{{#each items}}{{> components/item}}{{/each}}`,
    // A partial keeps its frontmatter; only the page being rendered has it removed.
    'components/card.html': `---
not: stripped
---
<div class="card">{{theme_settings.color}}</div>`,
    'components/item.html': '<li>{{this}}</li>',
};

/**
 * The default render path: assembled from disk and compiled by paper on every request.
 */
const uncachedAssembler = (templatesFolder) => ({
    async getTemplates(templatePath, processor) {
        const assembled = await promisify(templateAssembler.assemble)(
            templatesFolder,
            templatePath,
        );
        const match = assembled[templatePath].match(/---\r?\n[\S\s]*\r?\n---\r?\n([\S\s]*)$/);
        if (match && match[1]) {
            [, assembled[templatePath]] = match;
        }
        return processor(assembled);
    },
    getTranslations: async () => translations,
});

describe('CompiledThemeCache', () => {
    let templatesFolder;

    const render = async (assembler, { templateEngine, cdnUrl = '', acceptLanguage = 'en' }) => {
        let output;
        const h = {
            response: (body) => {
                output = body;
                return { code: () => ({ header: jest.fn() }) };
            },
        };
        const data = {
            template_file: 'pages/home',
            context: {
                settings: {
                    base_url: 'https://store.example',
                    secure_base_url: 'https://store.example',
                    cdn_url: cdnUrl,
                    theme_version_id: 'v1',
                },
                theme_settings: { color: 'red' },
                template_engine: templateEngine,
                items: ['a', 'b'],
            },
            headers: {},
            acceptLanguage,
            statusCode: 200,
        };
        const request = { headers: {}, query: {}, app: {} };
        await new PencilResponse(data, assembler).respond(request, h);
        return output;
    };

    beforeEach(() => {
        templatesFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-theme-cache-'));
        for (const [file, content] of Object.entries(templates)) {
            fs.mkdirSync(path.dirname(path.join(templatesFolder, file)), { recursive: true });
            fs.writeFileSync(path.join(templatesFolder, file), content);
        }
    });

    afterEach(() => {
        fs.rmSync(templatesFolder, { recursive: true, force: true });
    });

    it.each(['handlebars-v3', 'handlebars-v4'])(
        'should render exactly what the uncached path renders with %s',
        async (templateEngine) => {
            const cache = new CompiledThemeCache(templatesFolder, {
                loadTranslations: async () => translations,
            });

            const expected = await render(uncachedAssembler(templatesFolder), { templateEngine });
            const first = await render(cache, { templateEngine });
            const second = await render(cache, { templateEngine });

            expect(expected).toContain('not: stripped');
            expect(expected).not.toContain('featured: 4');
            expect(first).toEqual(expected);
            expect(second).toEqual(expected);
        },
    );

    it("should bind cached templates to each request's own settings and language", async () => {
        const cache = new CompiledThemeCache(templatesFolder, {
            loadTranslations: async () => translations,
        });

        const a = await render(cache, {
            templateEngine: 'handlebars-v3',
            cdnUrl: 'https://a.example',
            acceptLanguage: 'en',
        });
        const b = await render(cache, {
            templateEngine: 'handlebars-v3',
            cdnUrl: 'https://b.example',
            acceptLanguage: 'fr',
        });

        expect(a).toContain('https://a.example');
        expect(a).toContain('Hello');
        expect(b).toContain('https://b.example');
        expect(b).toContain('Bonjour');
        expect(b).not.toContain('https://a.example');
    });

    it('should keep serving the compiled theme without reading the files again', async () => {
        const cache = new CompiledThemeCache(templatesFolder, {
            loadTranslations: async () => translations,
        });
        await render(cache, { templateEngine: 'handlebars-v3' });

        fs.writeFileSync(path.join(templatesFolder, 'components/item.html'), '<p>changed</p>');
        const output = await render(cache, { templateEngine: 'handlebars-v3' });

        expect(output).toContain('<li>a</li>');
        expect(output).not.toContain('changed');
    });

    it('should retry a template that failed to load instead of caching the failure', async () => {
        const cache = new CompiledThemeCache(templatesFolder, {
            loadTranslations: async () => translations,
        });
        const { handlebars } = new Paper({}, {}, {}, 'handlebars-v3').getRenderer();

        await expect(cache.getTemplateSpecs('pages/missing', handlebars)).rejects.toThrow(
            'pages/missing',
        );
        fs.writeFileSync(path.join(templatesFolder, 'pages/missing.html'), '<p>now here</p>');

        await expect(cache.getTemplateSpecs('pages/missing', handlebars)).resolves.toHaveProperty(
            'pages/missing',
        );
    });
});
