import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { StyleSheet, colorScheme, vars } from 'nativewind';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createElement, Suspense, useEffect, type ReactElement } from 'react';
import { View } from 'react-native';
import 'react-native-css-interop/dist/runtime/components';
import { cssVariableObservable } from 'react-native-css-interop/dist/runtime/native/appearance-observables';
import { VariableContext } from 'react-native-css-interop/dist/runtime/native/styles';

import { useTokenColor } from '@/hooks/use-token-color';

// Metro sets this before loading the NativeWind preset. Jest does not run Metro.
const nativewindOs = process.env.NATIVEWIND_OS;
process.env.NATIVEWIND_OS = 'android';

interface Tree {
  update(element: ReactElement): void;
  unmount(): void;
}
const renderer = jest.requireActual<{
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): Tree;
}>(createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'));
const { cssToReactNativeRuntime } = jest.requireActual<
  typeof import('react-native-css-interop/css-to-rn')
>('react-native-css-interop/css-to-rn');
const postcss = jest.requireActual<
  (plugins: unknown[]) => {
    process(css: string, options: { from: string }): Promise<{ css: string }>;
  }
>(createRequire(require.resolve('tailwindcss')).resolve('postcss'));
const tailwind = jest.requireActual<(config: unknown) => unknown>('tailwindcss');
const config = jest.requireActual('../../tailwind.config');
const { cssToReactNativeRuntimeOptions } = jest.requireActual<
  typeof import('nativewind/dist/metro/common')
>('nativewind/dist/metro/common');
let tree: Tree | undefined;

async function compileStyles(platform = 'android') {
  process.env.NATIVEWIND_OS = platform;
  const path = resolve(__dirname, '../../global.css');
  const css = await postcss([tailwind(config)]).process(readFileSync(path, 'utf8'), {
    from: path,
  });
  return cssToReactNativeRuntime(css.css, cssToReactNativeRuntimeOptions);
}

function ColorReader({ capture }: { capture: (color: string | undefined) => void }) {
  const color = useTokenColor('printInk');
  useEffect(() => capture(color), [color, capture]);
  return null;
}

afterEach(async () => {
  await renderer.act(async () => tree?.unmount());
  tree = undefined;
  jest.restoreAllMocks();
});
afterAll(() => {
  if (nativewindOs === undefined) delete process.env.NATIVEWIND_OS;
  else process.env.NATIVEWIND_OS = nativewindOs;
});

describe('native color tokens', () => {
  it.each(['ios', 'android'])(
    'keeps the print colors in the compiled %s app stylesheet',
    async (platform) => {
      const compiled = await compileStyles(platform);
      expect(compiled.rootVariables?.['--color-printInk']?.light).toEqual([0, 0, 0]);
      expect(compiled.rootVariables?.['--color-printPaper']?.light).toEqual([255, 255, 255]);
    },
  );

  it('does not update a suspended color reader before it mounts', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    StyleSheet.registerCompiled({
      $compiled: true,
      rootVariables: { '--color-printPaper': { light: [255, 255, 255] } },
    });
    colorScheme.set('light');
    const suspended = new Promise<void>(() => undefined);
    function Reader(): null {
      useTokenColor('printPaper');
      throw suspended;
    }
    await renderer.act(async () => {
      tree = renderer.create(createElement(Suspense, { fallback: null }, createElement(Reader)));
    });
    await renderer.act(async () => {
      StyleSheet.registerCompiled({
        $compiled: true,
        rootVariables: { '--color-printPaper': { light: [254, 254, 254] } },
      });
    });
    expect(errors.mock.calls.map((call) => String(call[0]))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("hasn't mounted yet")]),
    );
  });

  it('keeps print colors fixed while mounted readers follow light and dark palettes', async () => {
    const capture = jest.fn<(colors: (string | undefined)[]) => void>();
    const compiled = await compileStyles();
    function Reader() {
      const ink = useTokenColor('printInk');
      const paper = useTokenColor('printPaper');
      const text = useTokenColor('textPrimary');
      useEffect(() => capture([ink, paper, text]), [ink, paper, text]);
      return null;
    }
    await renderer.act(async () => {
      StyleSheet.registerCompiled(compiled);
      colorScheme.set('light');
      tree = renderer.create(createElement(Reader));
    });
    expect(capture).toHaveBeenLastCalledWith([
      'rgba(0, 0, 0, 1)',
      'rgba(255, 255, 255, 1)',
      'rgba(30, 27, 23, 1)',
    ]);
    await renderer.act(async () => colorScheme.set('dark'));
    expect(capture).toHaveBeenLastCalledWith([
      'rgba(0, 0, 0, 1)',
      'rgba(255, 255, 255, 1)',
      'rgba(244, 239, 229, 1)',
    ]);
    await renderer.act(async () => colorScheme.set('light'));
    expect(capture).toHaveBeenLastCalledWith([
      'rgba(0, 0, 0, 1)',
      'rgba(255, 255, 255, 1)',
      'rgba(30, 27, 23, 1)',
    ]);
  });

  it('updates mounted readers when Fast Refresh replaces a token', async () => {
    const capture = jest.fn<(color: string | undefined) => void>();
    await renderer.act(async () => {
      StyleSheet.registerCompiled({
        $compiled: true,
        rootVariables: { '--color-printInk': { light: [0, 0, 0] } },
      });
      tree = renderer.create(createElement(ColorReader, { capture }));
    });
    expect(capture).toHaveBeenLastCalledWith('rgba(0, 0, 0, 1)');
    await renderer.act(async () => {
      StyleSheet.registerCompiled({
        $compiled: true,
        rootVariables: { '--color-printInk': { light: [1, 2, 3] } },
      });
    });
    expect(capture).toHaveBeenLastCalledWith('rgba(1, 2, 3, 1)');
  });

  it('reads an inherited token and follows a changed parent value', async () => {
    const capture = jest.fn<(color: string | undefined) => void>();
    const parent = (color: string) => (
      <View style={vars({ '--color-printInk': color })}>
        <ColorReader capture={capture} />
      </View>
    );
    await renderer.act(async () => {
      tree = renderer.create(parent('5 6 7'));
    });
    expect(capture).toHaveBeenLastCalledWith('rgba(5, 6, 7, 1)');
    await renderer.act(async () => tree?.update(parent('8 9 10')));
    expect(capture).toHaveBeenLastCalledWith('rgba(8, 9, 10, 1)');
  });

  it('removes its observable subscription when a mounted reader unmounts', async () => {
    const variable = cssVariableObservable({ light: [0, 0, 0] });
    const get = jest.spyOn(variable, 'get');
    const capture = jest.fn<(color: string | undefined) => void>();
    await renderer.act(async () => {
      tree = renderer.create(
        createElement(
          VariableContext.Provider,
          { value: { '--color-printInk': variable } },
          createElement(ColorReader, { capture }),
        ),
      );
    });
    const effect = get.mock.calls.find(([effect]) => effect)?.[0];
    expect(effect?.dependencies.size).toBeGreaterThan(0);
    await renderer.act(async () => tree?.unmount());
    tree = undefined;
    expect(effect?.dependencies.size).toBe(0);
    await renderer.act(async () => variable.set({ light: [1, 2, 3] }));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
