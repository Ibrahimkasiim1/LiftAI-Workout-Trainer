// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {
      // Metro resolves packages; flat eslint often flags workspace deps without a TS resolver.
      'import/no-unresolved': 'off',
    },
  },
]);
