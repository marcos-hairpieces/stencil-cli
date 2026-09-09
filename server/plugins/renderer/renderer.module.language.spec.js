import { register, getAcceptLanguageHeader } from './renderer.module.js';

// The renderer keeps its options in a module-level singleton, so this file registers the
// plugin against a stub server instead of sharing the real one in renderer.module.spec.js.
describe('Renderer Plugin accept-language', () => {
    const serverStub = { expose: () => {} };
    const requestWith = (headers) => ({ headers });

    describe('when the store picks the language from the browser', () => {
        beforeAll(() => {
            register(serverStub, {
                storeSettingsLocale: {
                    shopper_language_selection_method: 'browser',
                    default_shopper_language: 'en-CA',
                },
            });
        });

        it('should use the lower-cased Accept-Language header when the browser sends one', () => {
            const result = getAcceptLanguageHeader(
                requestWith({ 'accept-language': 'fr-CA,fr;Q=0.9' }),
            );

            expect(result).toEqual('fr-ca,fr;q=0.9');
        });

        it('should fall back to the default shopper language when no header is sent', () => {
            // curl, uptime monitors and health probes send no Accept-Language at all.
            const result = getAcceptLanguageHeader(requestWith({}));

            expect(result).toEqual('en-ca');
        });
    });

    describe('when the store always uses its default language', () => {
        beforeAll(() => {
            register(serverStub, {
                storeSettingsLocale: {
                    shopper_language_selection_method: 'default_shopper_language',
                    default_shopper_language: 'es',
                },
            });
        });

        it('should ignore the header and return the default shopper language', () => {
            const result = getAcceptLanguageHeader(requestWith({ 'accept-language': 'en-US' }));

            expect(result).toEqual('es');
        });
    });
});
