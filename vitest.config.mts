import { createStoryReporter } from 'executable-stories-vitest/reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The construct deploys prebuilt bundles; build them so tests synth what consumers get.
    globalSetup: ['./tools/bundle-lambdas.mts'],
    reporters: process.env.STORY_REPORT
      ? [
          'default',
          createStoryReporter({
            formats: ['html', 'markdown'],
            outputDir: 'reports',
            outputName: 'index',
          }),
        ]
      : ['default'],
  },
});
