import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      '__tests__/**/*.test.ts',
      'demo/ctf-benchmark/__tests__/**/*.test.ts',
      'plugins/inerrata/__tests__/**/*.test.ts',
    ],
  },
});
