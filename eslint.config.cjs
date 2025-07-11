module.exports = [
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        __dirname: true,
        Buffer: true,
        process: true,
        setTimeout: true,
        clearTimeout: true,
        console: true,
        Mocha: true,
        global: true,
        describe: true,
        it: true,
        expect: true,
        mocha: true,
      },
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        project: ['./tsconfig.json'],
        sourceType: 'module',
      },
    },

    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.ts', '.d.ts'],
        },
        typescript: {
          project: './tsconfig.json',
        },
      },
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
      import: require('eslint-plugin-import'),
    },
    rules: {
      ...require('@eslint/js').configs.recommended.rules,
      ...require('@typescript-eslint/eslint-plugin').configs[
        'eslint-recommended'
      ].rules,
      ...require('@typescript-eslint/eslint-plugin').configs.recommended.rules,
      ...require('eslint-plugin-import').configs.recommended.rules,
      'no-unused-expressions': 'off', // Disable the base rule
      '@typescript-eslint/no-unused-expressions': [
        'error',
        {
          allowShortCircuit: true,
          allowTaggedTemplates: true,
          allowTernary: true,
        },
      ],
      'import/namespace': 'off',
      'import/no-unresolved': 'off',
      'import/default': 'off',
      'import/named': 'off',
      'import/no-duplicates': 'off',
      'import/no-named-as-default': 'off',
      'import/no-named-as-default-member': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-async-promise-executor': 'off',
    },
  },
];
