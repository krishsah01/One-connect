// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'daemon',
          include: ['packages/daemon/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: { name: 'web', include: ['packages/web/test/**/*.test.tsx'], environment: 'jsdom' },
      },
    ],
  },
});
