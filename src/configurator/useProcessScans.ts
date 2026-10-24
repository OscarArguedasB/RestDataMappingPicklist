import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toUserMessage } from '../core/errors';
import type { LayoutControl } from '../core/migration';
import { canHoldControls } from '../devops/processes';
import type { ProcessSummary, SetupServices } from './services';

// The setup page reads every process's work item forms once, a few at a time, to find REST
// Picklist controls: the ones still set up the old way (for the banner), and which control uses
// which configuration. The page stays usable meanwhile; each process shows its own progress.

/** Processes read at the same time, so a large organization doesn't flood Azure DevOps. */
export const SCAN_CONCURRENCY = 3;

export type ScanState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; controls: LayoutControl[] };

export interface ProcessScans {
  /** By process id; processes that can't hold controls aren't scanned. */
  states: ReadonlyMap<string, ScanState>;
  /** Processes read (or failed) so far, of `total`. */
  done: number;
  total: number;
  /** Every control found so far, in every process. */
  controls: readonly LayoutControl[];
  rescan: (process: Pick<ProcessSummary, 'id' | 'name'>) => void;
  /** Puts a control as Azure DevOps returned it after a change in place of the old one. */
  replaceControl: (control: LayoutControl) => void;
}

/** Runs `task` for every item, at most `limit` at once, in order. `task` must not reject. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await task(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function sameControl(a: LayoutControl, b: LayoutControl): boolean {
  return (
    a.processId === b.processId &&
    a.workItemType.referenceName === b.workItemType.referenceName &&
    a.controlId === b.controlId
  );
}

/**
 * Scans the processes that can hold controls once they're known, `priorityId` first, and keeps
 * the results. A newer scan of a process replaces an older one that answers late.
 */
export function useProcessScans(
  services: SetupServices,
  processes: readonly ProcessSummary[] | null,
  priorityId: string
): ProcessScans {
  const [states, setStates] = useState<ReadonlyMap<string, ScanState>>(() => new Map());
  // The latest request per process; answers to older ones are dropped.
  const requests = useRef(new Map<string, number>());
  const counter = useRef(0);
  const priority = useRef(priorityId);
  useEffect(() => {
    priority.current = priorityId;
  });

  const scan = useCallback(
    async (process: Pick<ProcessSummary, 'id' | 'name'>) => {
      counter.current += 1;
      const request = counter.current;
      requests.current.set(process.id, request);
      setStates((current) => new Map(current).set(process.id, { status: 'loading' }));
      let next: ScanState;
      try {
        next = {
          status: 'ready',
          controls: await services.scanProcessControls({ id: process.id, name: process.name }),
        };
      } catch (error) {
        next = { status: 'error', message: toUserMessage(error) };
      }
      if (requests.current.get(process.id) === request) {
        setStates((current) => new Map(current).set(process.id, next));
      }
    },
    [services]
  );

  const targets = useMemo(() => (processes ?? []).filter(canHoldControls), [processes]);

  useEffect(() => {
    if (targets.length === 0) {
      return undefined;
    }
    let active = true;
    const first = priority.current;
    const ordered = targets.toSorted((a, b) => Number(b.id === first) - Number(a.id === first));
    setStates(new Map(ordered.map((process) => [process.id, { status: 'loading' } as const])));
    void runWithConcurrency(ordered, SCAN_CONCURRENCY, async (process) => {
      if (active) {
        await scan(process);
      }
    });
    const pending = requests.current;
    return () => {
      active = false;
      // Answers to these scans no longer matter.
      pending.clear();
    };
  }, [targets, scan]);

  const rescan = useCallback(
    (process: Pick<ProcessSummary, 'id' | 'name'>) => void scan(process),
    [scan]
  );

  const replaceControl = useCallback((control: LayoutControl) => {
    setStates((current) => {
      const state = current.get(control.processId);
      if (state?.status !== 'ready') {
        return current;
      }
      return new Map(current).set(control.processId, {
        status: 'ready',
        controls: state.controls.map((existing) =>
          sameControl(existing, control) ? control : existing
        ),
      });
    });
  }, []);

  return useMemo(() => {
    let done = 0;
    const controls: LayoutControl[] = [];
    for (const process of targets) {
      const state = states.get(process.id);
      if (state && state.status !== 'loading') {
        done += 1;
      }
      if (state?.status === 'ready') {
        controls.push(...state.controls);
      }
    }
    return { states, done, total: targets.length, controls, rescan, replaceControl };
  }, [states, targets, rescan, replaceControl]);
}
