import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Component tests opt into jsdom with a `@vitest-environment jsdom` comment.
    environment: 'node',
  },
});
