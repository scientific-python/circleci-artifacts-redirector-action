import { defineConfig } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'

export default defineConfig([{
    ignores: ['dist/**'],
}, {
    extends: [js.configs.recommended],

    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            Atomics: 'readonly',
            SharedArrayBuffer: 'readonly',
        },

        ecmaVersion: 2022,
        sourceType: 'module',
    },

    // The codebase was written without semicolons, so enforce that rather than
    // churn every line. All of these are autofixable with `npx eslint . --fix`.
    rules: {
        eqeqeq: ['error', 'always', {null: 'ignore'}],
        'no-var': 'error',
        'prefer-const': 'error',
        quotes: ['error', 'single', {avoidEscape: true}],
        semi: ['error', 'never'],
    },
}])