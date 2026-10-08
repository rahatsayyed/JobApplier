import { defineConfig } from 'vitest/config';

// .superpowers/ holds git-ignored scratch (cloned third-party repos, eval harness, SDD workspaces).
// Their test files must never be collected or executed by `npm test`.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.superpowers/**', 'renderer/automation/**'],
  },
});
