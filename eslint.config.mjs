// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'dist-test/**', 'dist-dbg/**', 'tmp/**', 'node_modules/**'],
    },
    {
        files: ['**/*.{mts,ts,mjs,js}'],
        plugins: { '@typescript-eslint': tseslint.plugin },
        languageOptions: {
            parser: tseslint.parser,
        },
        rules: {
            complexity: ['error', 10],
        },
    },
);
