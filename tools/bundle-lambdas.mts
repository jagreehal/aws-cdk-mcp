// Bundles the construct's own Lambdas into lambda/<name>/index.js at build time, so the published
// package ships them ready to deploy: consumers need neither esbuild nor Docker to synth.
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');

export default async function bundleLambdas(): Promise<void> {
  await Promise.all(
    ['api-key-authorizer', 'google-authorizer', 'protected-resource'].map((name) =>
      build({
        entryPoints: [join(root, 'src/runtime', `${name}.ts`)],
        outfile: join(root, 'lambda', name, 'index.js'),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        minify: true,
        logLevel: 'warning',
      }),
    ),
  );
}

if (import.meta.main) await bundleLambdas();
