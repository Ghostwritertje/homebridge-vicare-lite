import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores: ['dist']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'quotes': ['warn', 'single'],
      'indent': ['warn', 2, {SwitchCase: 1}],
      'comma-dangle': ['warn', 'always-multiline'],
      'eqeqeq': 'warn',
      'curly': ['warn', 'all'],
      'max-len': ['warn', 140],
      'no-console': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
