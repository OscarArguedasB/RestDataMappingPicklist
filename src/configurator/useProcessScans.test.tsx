/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PicklistError } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import type { ProcessSummary, SetupServices } from './services';
import { PROCESSES, fakeServices, layoutControl } from './testUtils';
import { SCAN_CONCURRENCY, runWithConcurrency, useProcessScans } from './useProcessScans';

vi.mock('azure-devops-extension-sdk', () => ({}));

/** A promise to settle from the test, like Promise.withResolvers. */
function deferred<T>() {
  const handlers: { resolve?: (value: T) => void; reject?: (reason: unknown) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => handlers.resolve?.(value),
    reject: (reason: unknown) => handlers.reject?.(reason),
  };
}

function inherited(count: number): ProcessSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `p-${index}`,
    name: `Process ${index}`,
    customizationType: 'inherited',
    isEnabled: true,
    projectNames: [],
    projectIds: [],
    parentProcessTypeId: 'p-agile',
  }));
}

describe('runWithConcurrency', () => {
  it('runs every item in order, never more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      started.push(item);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, item % 3));
      running -= 1;
    });
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
    await expect(runWithConcurrency([], 3, async () => undefined)).resolves.toBeUndefined();
  });
});

describe('useProcessScans', () => {
  it('scans the chosen process first, a few at a time, and counts progress', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<LayoutControl[]>>>();
    const scanProcessControls = vi.fn<SetupServices['scanProcessControls']>((process) => {
      const next = deferred<LayoutControl[]>();
      pending.set(process.id, next);
      return next.promise;
    });
    const services = fakeServices({ scanProcessControls });
    const processes = [...PROCESSES.slice(0, 1), ...inherited(5)];
    const { result } = renderHook(() => useProcessScans(services, processes, 'p-3'));

    await waitFor(() => expect(scanProcessControls).toHaveBeenCalledTimes(SCAN_CONCURRENCY));
    // System processes can't hold controls, so they aren't read.
    expect(scanProcessControls.mock.calls.map(([process]) => process.id)).toEqual([
      'p-3',
      'p-0',
      'p-1',
    ]);
    expect(result.current.total).toBe(5);
    expect(result.current.done).toBe(0);

    const control = layoutControl({ processId: 'p-3', processName: 'Process 3' });
    await act(async () => {
      pending.get('p-3')?.resolve([control]);
      pending.get('p-0')?.reject(new PicklistError('http', 'You don’t have permission.', 403));
    });
    await waitFor(() => expect(scanProcessControls).toHaveBeenCalledTimes(5));
    expect(result.current.done).toBe(2);
    expect(result.current.states.get('p-0')).toEqual({
      status: 'error',
      message: 'You don’t have permission.',
    });
    expect(result.current.controls).toEqual([control]);

    await act(async () => {
      for (const id of ['p-1', 'p-2', 'p-4']) {
        pending.get(id)?.resolve([]);
      }
    });
    await waitFor(() => expect(result.current.done).toBe(5));
  });

  it('rescans one process, ignores late answers and replaces changed controls', async () => {
    const control = layoutControl();
    const first = deferred<LayoutControl[]>();
    const scanProcessControls = vi
      .fn<SetupServices['scanProcessControls']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue([control]);
    const services = fakeServices({ scanProcessControls });
    const processes = PROCESSES.filter((process) => process.id === 'p-contoso');
    const { result } = renderHook(() => useProcessScans(services, processes, ''));
    await waitFor(() => expect(scanProcessControls).toHaveBeenCalledTimes(1));

    act(() => result.current.rescan({ id: 'p-contoso', name: 'Contoso Agile' }));
    await waitFor(() => expect(result.current.states.get('p-contoso')?.status).toBe('ready'));
    // The first scan answers after the second: it no longer counts.
    await act(async () => first.resolve([]));
    expect(result.current.controls).toEqual([control]);

    const updated = { ...control, inputs: { FieldName: 'Custom.Customer', Configuration: 'X' } };
    act(() => result.current.replaceControl(updated));
    expect(result.current.controls).toEqual([updated]);
  });
});
