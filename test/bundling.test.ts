import { build } from 'esbuild';
import { story } from 'executable-stories-vitest';
import { expect, test } from 'vitest';

story.feature({
  title: 'Bundling',
  narrative: `
    The construct and its runtime handlers must bundle without Autotel or OpenTelemetry,
    so consumers who do not opt in pay nothing for tracing. Instrumentation lives in a
    separate entry point.
  `,
  tags: ['bundling'],
});

for (const entry of [
  'src/index.ts',
  'src/runtime/api-key-authorizer.ts',
  'src/runtime/google-authorizer.ts',
  'example/mcp.ts',
]) {
  test(`${entry} bundles without Autotel or OpenTelemetry`, async ({ task }) => {
    story.init(task);

    story.given(`the entry point ${entry}`);
    story.when('it is bundled with esbuild');

    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      write: false,
      metafile: true,
      packages: entry === 'src/index.ts' ? 'external' : undefined,
    });

    story.then('no Autotel or OpenTelemetry module is among its inputs');
    expect(
      Object.keys(bundle.metafile.inputs).filter((input) => /autotel|opentelemetry/.test(input)),
    ).toEqual([]);
    story.and('the output does not require autotel');
    expect(bundle.metafile.outputs).toBeDefined();
    expect(bundle.outputFiles[0].text).not.toMatch(/require\(["']autotel/);
  });
}

test('the separate Autotel entry point bundles its Lambda and MCP instrumentation', async ({
  task,
}) => {
  story.init(task);

  story.given('the example/mcp-autotel.ts entry point');
  story.when('it is bundled with esbuild');

  const bundle = await build({
    entryPoints: ['example/mcp-autotel.ts'],
    bundle: true,
    platform: 'node',
    write: false,
    metafile: true,
  });

  story.then('autotel-aws is bundled for the Lambda');
  expect(Object.keys(bundle.metafile.inputs).some((input) => input.includes('autotel-aws'))).toBe(
    true,
  );
  story.and('autotel-mcp-instrumentation is bundled for the MCP server');
  expect(
    Object.keys(bundle.metafile.inputs).some((input) =>
      input.includes('autotel-mcp-instrumentation'),
    ),
  ).toBe(true);
});

test('src/runtime/identify.ts bundles without aws-cdk-lib, so handlers can import it', async ({
  task,
}) => {
  story.init(task);

  story.given('the runtime entry point consumers import as aws-cdk-mcp/runtime');
  story.when('it is bundled with esbuild');

  const bundle = await build({
    entryPoints: ['src/runtime/identify.ts'],
    bundle: true,
    platform: 'node',
    write: false,
    metafile: true,
  });

  story.then('no aws-cdk-lib or constructs module is among its inputs');
  expect(
    Object.keys(bundle.metafile.inputs).filter((input) => /aws-cdk-lib|constructs/.test(input)),
  ).toEqual([]);
});

test('package.json exports aws-cdk-mcp/runtime', async ({ task }) => {
  story.init(task);

  story.given('the published package.json');
  const pkg = (await import('../package.json', { with: { type: 'json' } })).default;

  story.then('"./runtime" points at the compiled identify module');
  expect(pkg.exports['./runtime']).toEqual({
    types: './dist/runtime/identify.d.ts',
    default: './dist/runtime/identify.js',
  });
});
