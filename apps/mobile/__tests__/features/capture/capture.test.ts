import { describe, expect, it, jest } from '@jest/globals';
import { CaptureController, type CaptureDependencies } from '@/features/capture/capture';
import type { ShotContext } from '@/features/capture/context';

const shot: ShotContext = {
  userId: 'A',
  eventId: 'event',
  subEventId: 'sub',
  capturedAt: '2026-10-10T10:00:00Z',
  mode: 'public',
};
function setup(step?: string) {
  let owner: string | null = 'A';
  const calls: string[] = [];
  const mark = async (name: string) => {
    calls.push(name);
    if (name === step) owner = 'B';
  };
  const deps: CaptureDependencies = {
    userId: () => owner,
    makeId: () => 'capture-1',
    permission: async () => {
      await mark('permission');
      return true;
    },
    take: async () => {
      await mark('take');
      return 'file:///camera.jpg';
    },
    exclude: async () => {
      await mark('exclude');
    },
    persist: async () => {
      await mark('persist');
    },
    saveGallery: async () => {
      await mark('gallery');
    },
    claimGallery: async () => {
      await mark('claim');
      return true;
    },
    galleryResult: async () => {
      await mark('result');
    },
    handoff: async () => {
      await mark('handoff');
    },
    discardTemporary: async () => {
      calls.push('discard');
    },
  };
  return { deps, calls, controller: new CaptureController(deps) };
}
describe('capture isolation and gallery gate', () => {
  it('reports the durable draft even if recording the gallery result fails', async () => {
    const { controller, deps, calls } = setup();
    deps.galleryResult = async () => {
      throw new Error('database unavailable');
    };
    expect(await controller.capture(shot)).toMatchObject({ durable: true, queued: false });
    expect(calls).toContain('persist');
    expect(calls).not.toContain('handoff');
  });
  it('Local Only never requests gallery access, saves to the gallery, or hands off to uploads', async () => {
    const { controller, calls } = setup();
    await controller.capture({ ...shot, mode: 'local_only' });
    expect(calls).toEqual(['exclude', 'take', 'persist', 'discard']);
  });
  it('backup exclusion failure prevents Local Only before taking a shot', async () => {
    const { controller, deps, calls } = setup();
    deps.exclude = async () => {
      throw new Error('Backup exclusion failed');
    };
    await expect(controller.capture({ ...shot, mode: 'local_only' })).rejects.toThrow(
      'Backup exclusion',
    );
    expect(calls).toEqual([]);
  });
  it('gallery permission denial prevents Public capture', async () => {
    const { controller, deps, calls } = setup();
    deps.permission = async () => false;
    await expect(controller.capture(shot)).rejects.toThrow('gallery');
    expect(calls).toEqual([]);
  });
  it('gallery failure retains a durable draft and never uploads', async () => {
    const { controller, deps, calls } = setup();
    deps.saveGallery = async () => {
      throw new Error('disk');
    };
    expect(await controller.capture(shot)).toMatchObject({ durable: true, queued: false });
    expect(calls).toContain('persist');
    expect(calls).not.toContain('handoff');
  });
  it.each(['permission', 'exclude', 'take', 'persist', 'claim', 'gallery', 'result'])(
    'does not continue under another account after %s',
    async (step) => {
      const { controller, calls } = setup(step);
      await controller.capture(shot).catch(() => undefined);
      expect(calls).not.toContain('handoff');
      if (step === 'permission' || step === 'exclude') expect(calls).not.toContain('take');
      if (step === 'take') expect(calls).not.toContain('persist');
    },
  );
  it('ignores a second shutter while the first is in progress', async () => {
    const { controller, deps } = setup();
    let release!: (uri: string) => void;
    deps.take = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = controller.capture(shot);
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    await expect(controller.capture(shot)).rejects.toThrow('progress');
    release('file:///camera.jpg');
    await first;
    expect(deps.take).toHaveBeenCalledTimes(1);
  });
});
