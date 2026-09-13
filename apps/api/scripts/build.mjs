// Bundles src/index.ts into dist/index.js, which systemd runs with `node dist/index.js`
// (Handbook §13).
//
// Why a bundle and not plain tsc: @momentlens/shared-types exports TypeScript source,
// and tsc will not emit files from outside this package. So workspace packages are
// compiled into the bundle, and every registry package stays external and loads from
// node_modules at runtime, exactly as it does under `pnpm dev`.

import { build } from 'esbuild';

const WORKSPACE_SCOPE = '@momentlens/';

/** @type {import('esbuild').Plugin} */
const externalizeRegistryPackages = {
  name: 'externalize-registry-packages',
  setup(pluginBuild) {
    // Bare specifiers only: relative and absolute paths are this package's own files.
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point' || args.path.startsWith(WORKSPACE_SCOPE)) {
        return undefined;
      }
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  plugins: [externalizeRegistryPackages],
  logLevel: 'info',
});
