import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, editorKey, hashForRoute, routeFromHash } from './routes';

describe('routes', () => {
  it('reads the tabs, the editor and 3.0 bookmarks', () => {
    expect(routeFromHash('#configurations')).toEqual(DEFAULT_ROUTE);
    expect(routeFromHash('#Policy')).toEqual({ tab: 'policy', editor: null });
    expect(routeFromHash('#build')).toEqual(DEFAULT_ROUTE);
    expect(routeFromHash('saved')).toEqual(DEFAULT_ROUTE);
    expect(routeFromHash('#edit=6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21')).toEqual({
      tab: 'configurations',
      editor: { kind: 'edit', id: '6f1c0f3e-3f0b-4c55-9a43-0d3a6c1e9b21' },
    });
    expect(routeFromHash('#new=p-contoso')).toEqual({
      tab: 'configurations',
      editor: { kind: 'new', processId: 'p-contoso' },
    });
  });

  it('ignores anything else', () => {
    for (const hash of [
      '',
      '#',
      '#other',
      '#policy=1',
      '#edit=',
      '#edit=../secrets',
      '#edit=%E0%A4%A',
      '#new=a b',
      `#edit=${'a'.repeat(51)}`,
    ]) {
      expect(routeFromHash(hash)).toBeNull();
    }
  });

  it('writes hashes that read back the same', () => {
    const routes = [
      DEFAULT_ROUTE,
      { tab: 'policy', editor: null } as const,
      { tab: 'configurations', editor: { kind: 'edit', id: 'cfg-1' } } as const,
      { tab: 'configurations', editor: { kind: 'new', processId: 'p-contoso' } } as const,
    ];
    for (const route of routes) {
      expect(routeFromHash(hashForRoute(route))).toEqual(route);
    }
    expect(hashForRoute(DEFAULT_ROUTE)).toBe('configurations');
    expect(editorKey({ kind: 'edit', id: 'x' })).not.toBe(
      editorKey({ kind: 'new', processId: 'x' })
    );
  });
});
