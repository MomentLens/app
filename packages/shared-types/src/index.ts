// The app↔API contract. The first PR of every slice adds its zod schema here, and
// both apps/mobile and apps/api import it from this package (docs/WorkSlices.md).
//
// This package ships TypeScript source with no build step. Metro, tsx, Jest and
// the API's esbuild bundle all compile it where it is used, so nothing here may
// depend on Node or DOM globals.
export {};
