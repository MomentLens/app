import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CameraReadiness } from '@/features/capture/camera-readiness';

afterEach(() => {
  jest.useRealTimers();
});
describe('capture readiness across interruptions', () => {
  it('withholds a waiting shot until the current camera reports ready', async () => {
    const camera = new CameraReadiness();
    const take = jest.fn();
    const shot = camera.wait().then(take);
    await Promise.resolve();
    expect(take).not.toHaveBeenCalled();
    camera.setReady(true);
    await shot;
    expect(take).toHaveBeenCalledTimes(1);
    expect(camera.isReady()).toBe(true);
  });
  it('does not reuse readiness from before a pause', async () => {
    const camera = new CameraReadiness();
    camera.setReady(true);
    camera.setReady(false);
    const take = jest.fn();
    const shot = camera.wait().then(take);
    await Promise.resolve();
    expect(take).not.toHaveBeenCalled();
    camera.setReady(true);
    await shot;
    expect(take).toHaveBeenCalledTimes(1);
  });
  it('rejects waiting shots when the screen closes', async () => {
    const camera = new CameraReadiness();
    const shot = camera.wait();
    camera.cancel();
    await expect(shot).rejects.toThrow('camera closed');
    camera.setReady(true);
    expect(camera.isReady()).toBe(true);
  });
  it('times out without taking a shot if the camera never becomes ready', async () => {
    jest.useFakeTimers();
    const camera = new CameraReadiness();
    const take = jest.fn();
    const shot = camera.wait().then(take);
    const rejection = expect(shot).rejects.toThrow('still starting');
    jest.advanceTimersByTime(15_000);
    await rejection;
    camera.setReady(true);
    expect(take).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
