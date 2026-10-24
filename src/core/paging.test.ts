import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PagingConfig } from './config';
import type { LoadRowsOptions, LoadRowsProgress } from './paging';
import { loadRows, nextLinkFromHeader, withQueryParameter } from './paging';
import { DEFAULT_POLICY } from './policy';
import type { PreparedRequest } from './request';

const request: PreparedRequest = {
  url: 'https://api.example.com/items?active=true',
  headers: { Accept: 'application/json', 'x-api-key': 'secret' },
  cacheKey: 'unused',
};

interface Reply {
  body: unknown;
  headers?: Record<string, string>;
  /** The final URL after a redirect. */
  url?: string;
}

function hrefOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** A fetch that answers each URL from a table (404 otherwise) and records every call. */
function server(routes: Record<string, Reply>) {
  return vi.fn<typeof fetch>(async (input) => {
    const reply = routes[hrefOf(input)];
    if (!reply) {
      return new Response('', { status: 404 });
    }
    const response = new Response(JSON.stringify(reply.body), { headers: reply.headers });
    if (reply.url) {
      Object.defineProperty(response, 'url', { value: reply.url });
    }
    return response;
  });
}

function calledUrls(fetchImpl: ReturnType<typeof server>): string[] {
  return fetchImpl.mock.calls.map(([input]) => hrefOf(input));
}

function options(
  paging: PagingConfig,
  fetchImpl: typeof fetch,
  overrides: Partial<LoadRowsOptions> = {}
): LoadRowsOptions {
  return {
    request,
    arrayPath: '',
    paging,
    maxItems: 10_000,
    maxPages: 10,
    fetchOptions: { fetchImpl },
    ...overrides,
  };
}

const nextLink = (path = ''): PagingConfig => ({ type: 'nextLink', nextLink: path, maxPages: 10 });

const page = (): Extract<PagingConfig, { type: 'page' }> => ({
  type: 'page',
  pageParam: 'page',
  sizeParam: 'per_page',
  size: 2,
  startPage: 1,
  maxPages: 10,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadRows without paging', () => {
  it('loads one page, detects the list and reports progress', async () => {
    const fetchImpl = server({
      [request.url]: {
        body: { meta: { count: 3 }, data: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } },
      },
    });
    const progress: LoadRowsProgress[] = [];
    const result = await loadRows(
      options({ type: 'none' }, fetchImpl, { onProgress: (update) => progress.push(update) })
    );
    expect(result).toMatchObject({
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
      pages: 1,
      truncated: false,
      arrayPath: 'data.items',
    });
    expect(result.firstResponse).toHaveProperty('meta.count', 3);
    expect(progress.map((update) => [update.page, update.done, update.rows.length])).toEqual([
      [1, false, 3],
      [1, true, 3],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps only the first maxItems rows', async () => {
    const fetchImpl = server({ [request.url]: { body: [1, 2, 3, 4, 5] } });
    const result = await loadRows(options({ type: 'none' }, fetchImpl, { maxItems: 2 }));
    expect(result).toMatchObject({ rows: [1, 2], truncated: true, arrayPath: '' });
    const exact = await loadRows(options({ type: 'none' }, fetchImpl, { maxItems: 5 }));
    expect(exact.truncated).toBe(false);
  });

  it('never follows a Link header', async () => {
    const fetchImpl = server({
      [request.url]: { body: [1], headers: { Link: '<https://api.example.com/2>; rel="next"' } },
    });
    expect((await loadRows(options({ type: 'none' }, fetchImpl))).pages).toBe(1);
  });

  it('refuses an endpoint the policy doesn’t allow', async () => {
    const fetchImpl = server({});
    await expect(
      loadRows(
        options({ type: 'none' }, fetchImpl, {
          policy: { ...DEFAULT_POLICY, allowedHosts: ['other.example.com'] },
        })
      )
    ).rejects.toMatchObject({ kind: 'config' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('loadRows with next links', () => {
  it('follows a link in the body, relative to the current page', async () => {
    const fetchImpl = server({
      [request.url]: { body: { value: [1, 2], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { value: [3], next: 'items?page=3' } },
      'https://api.example.com/items?page=3': { body: { value: [4], next: null } },
    });
    const progress: number[] = [];
    const result = await loadRows(
      options(nextLink('next'), fetchImpl, {
        arrayPath: 'value',
        onProgress: ({ rows, done }) => progress.push(done ? -rows.length : rows.length),
      })
    );
    expect(result).toMatchObject({ rows: [1, 2, 3, 4], pages: 3, truncated: false });
    expect(progress).toEqual([2, 3, 4, -4]);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toEqual(request.headers);
    }
  });

  it('finds well-known next links when no path is set', async () => {
    const fetchImpl = server({
      [request.url]: {
        body: { value: [1], '@odata.nextLink': 'https://api.example.com/items?$skiptoken=a' },
      },
      'https://api.example.com/items?$skiptoken=a': {
        body: { value: [2], links: { next: { href: '/items?$skiptoken=b' } } },
      },
      'https://api.example.com/items?$skiptoken=b': { body: { value: [3], next: 'cursor-abc' } },
    });
    const result = await loadRows(options(nextLink(), fetchImpl));
    // "cursor-abc" isn't a link, so it's never fetched as one.
    expect(result).toMatchObject({ rows: [1, 2, 3], pages: 3, arrayPath: 'value' });
  });

  it('follows the Link header', async () => {
    const fetchImpl = server({
      [request.url]: {
        body: [1],
        headers: {
          Link: '<https://api.example.com/items?page=9>; rel="last", <https://api.example.com/items?page=2>; rel="next"',
        },
      },
      'https://api.example.com/items?page=2': {
        body: [2],
        headers: { Link: '</items?page=1>; rel="prev first"' },
      },
    });
    const result = await loadRows(options(nextLink(), fetchImpl));
    expect(result).toMatchObject({ rows: [1, 2], pages: 2, truncated: false });
  });

  it('uses the Link header when the configured body path is empty', async () => {
    const fetchImpl = server({
      [request.url]: {
        body: { items: [1], next: null },
        headers: { link: '</items?page=2>; rel=next' },
      },
      'https://api.example.com/items?page=2': { body: { items: [2] } },
    });
    const result = await loadRows(options(nextLink('next'), fetchImpl));
    expect(result.rows).toEqual([1, 2]);
  });

  it('resolves relative links against the final URL of a same-site redirect', async () => {
    const fetchImpl = server({
      [request.url]: {
        body: { items: [1], next: 'page2' },
        url: 'https://api.example.com/v2/items',
      },
      'https://api.example.com/v2/page2': { body: { items: [2] } },
    });
    const result = await loadRows(options(nextLink('next'), fetchImpl));
    expect(result.rows).toEqual([1, 2]);
  });

  it('never sends credentials to another site', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = server({
      [request.url]: { body: { items: [1], next: 'https://evil.example.net/items?page=2' } },
    });
    const result = await loadRows(options(nextLink('next'), fetchImpl));
    expect(result).toMatchObject({ rows: [1], pages: 1, truncated: true });
    expect(calledUrls(fetchImpl)).toEqual([request.url]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('https://evil.example.net'));
    // Only the origin is logged; the link itself may contain tokens.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('page=2'));
  });

  it('refuses links that change the scheme or carry credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const links = [
      'http://api.example.com/items?page=2',
      'https://user:pw@api.example.com/items?page=2',
      'javascript:alert(1)',
      'https://api.example.com:8443/items?page=2',
    ];
    const outcomes = await Promise.all(
      links.map(async (link) => {
        const fetchImpl = server({ [request.url]: { body: { items: [1], next: link } } });
        const result = await loadRows(options(nextLink('next'), fetchImpl));
        return { link, truncated: result.truncated, calls: fetchImpl.mock.calls.length };
      })
    );
    expect(outcomes).toEqual(links.map((link) => ({ link, truncated: true, calls: 1 })));
  });

  it('checks next links against the policy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const localRequest = { ...request, url: 'http://localhost:3000/items' };
    const fetchImpl = server({
      [localRequest.url]: { body: { items: [1], next: '/items?page=2' } },
      'http://localhost:3000/items?page=2': { body: { items: [2] } },
    });
    const allowed = await loadRows(
      options(nextLink('next'), fetchImpl, {
        request: localRequest,
        policy: { ...DEFAULT_POLICY, allowLocalhost: true },
      })
    );
    expect(allowed.rows).toEqual([1, 2]);
    await expect(
      loadRows(options(nextLink('next'), fetchImpl, { request: localRequest }))
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('stops when a link repeats an earlier page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = server({
      [request.url]: { body: { items: [1], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { items: [2], next: request.url } },
    });
    const result = await loadRows(options(nextLink('next'), fetchImpl));
    expect(result).toMatchObject({ rows: [1, 2], pages: 2, truncated: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('repeats an earlier one'));
  });

  it('stops at maxPages and says more data existed', async () => {
    const fetchImpl = server(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          index === 0 ? request.url : `https://api.example.com/items?page=${index + 1}`,
          { body: { items: [index + 1], next: `/items?page=${index + 2}` } },
        ])
      )
    );
    const result = await loadRows(options(nextLink('next'), fetchImpl, { maxPages: 3 }));
    expect(result).toMatchObject({ rows: [1, 2, 3], pages: 3, truncated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops at maxItems in the middle of a page', async () => {
    const fetchImpl = server({
      [request.url]: { body: { items: [1, 2], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { items: [3, 4], next: '/items?page=3' } },
    });
    const result = await loadRows(options(nextLink('next'), fetchImpl, { maxItems: 3 }));
    expect(result).toMatchObject({ rows: [1, 2, 3], pages: 2, truncated: true });
  });

  it('stops at maxItems at the end of a page only when more pages exist', async () => {
    const fetchImpl = server({
      [request.url]: { body: { items: [1, 2], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { items: [3, 4] } },
    });
    const more = await loadRows(options(nextLink('next'), fetchImpl, { maxItems: 2 }));
    expect(more).toMatchObject({ rows: [1, 2], pages: 1, truncated: true });
    const complete = await loadRows(options(nextLink('next'), fetchImpl, { maxItems: 4 }));
    expect(complete).toMatchObject({ rows: [1, 2, 3, 4], pages: 2, truncated: false });
  });

  it('ends on an empty page or a page without the list', async () => {
    const empty = server({
      [request.url]: { body: { items: [1], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { items: [], next: '/items?page=3' } },
    });
    expect(await loadRows(options(nextLink('next'), empty))).toMatchObject({
      rows: [1],
      pages: 2,
      truncated: false,
    });
    const missing = server({
      [request.url]: { body: { items: [1], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { next: '/items?page=3' } },
    });
    expect(await loadRows(options(nextLink('next'), missing))).toMatchObject({
      rows: [1],
      pages: 2,
    });
  });

  it('fails when the first page has no list', async () => {
    const fetchImpl = server({ [request.url]: { body: { count: 0 } } });
    await expect(loadRows(options(nextLink(), fetchImpl))).rejects.toMatchObject({
      kind: 'shape',
    });
  });

  it('stops when cancelled between pages', async () => {
    const controller = new AbortController();
    const fetchImpl = server({
      [request.url]: { body: { items: [1], next: '/items?page=2' } },
      'https://api.example.com/items?page=2': { body: { items: [2] } },
    });
    await expect(
      loadRows({
        ...options(nextLink('next'), fetchImpl),
        fetchOptions: { fetchImpl, signal: controller.signal },
        onProgress: () => controller.abort(),
      })
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes a failing page’s error on', async () => {
    const fetchImpl = server({
      [request.url]: { body: { items: [1], next: '/items?page=2' } },
    });
    await expect(loadRows(options(nextLink('next'), fetchImpl))).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });
});

describe('loadRows with page numbers and offsets', () => {
  it('requests numbered pages until a short page', async () => {
    const fetchImpl = server({
      'https://api.example.com/items?active=true&page=1&per_page=2': { body: [1, 2] },
      'https://api.example.com/items?active=true&page=2&per_page=2': { body: [3, 4] },
      'https://api.example.com/items?active=true&page=3&per_page=2': { body: [5] },
    });
    const result = await loadRows(options(page(), fetchImpl));
    expect(result).toMatchObject({ rows: [1, 2, 3, 4, 5], pages: 3, truncated: false });
  });

  it('ends on an empty page and replaces page parameters already in the URL', async () => {
    const fetchImpl = server({
      'https://api.example.com/items?q=a%20b+c&page=0&per_page=2': { body: [1, 2] },
      'https://api.example.com/items?q=a%20b+c&page=1&per_page=2': { body: [] },
    });
    const result = await loadRows(
      options({ ...page(), startPage: 0 }, fetchImpl, {
        request: { ...request, url: 'https://api.example.com/items?page=7&q=a%20b+c' },
      })
    );
    expect(result).toMatchObject({ rows: [1, 2], pages: 2, truncated: false });
  });

  it('stops at maxPages while pages are still full', async () => {
    const fetchImpl = server({
      'https://api.example.com/items?active=true&page=1&per_page=2': { body: [1, 2] },
      'https://api.example.com/items?active=true&page=2&per_page=2': { body: [3, 4] },
    });
    const result = await loadRows(options(page(), fetchImpl, { maxPages: 2 }));
    expect(result).toMatchObject({ rows: [1, 2, 3, 4], pages: 2, truncated: true });
  });

  it('requests offsets until a short page', async () => {
    const offset: PagingConfig = {
      type: 'offset',
      offsetParam: 'skip',
      limitParam: 'take',
      limit: 2,
      maxPages: 10,
    };
    const fetchImpl = server({
      'https://api.example.com/items?active=true&skip=0&take=2': { body: { rows: [1, 2] } },
      'https://api.example.com/items?active=true&skip=2&take=2': { body: { rows: [3, 4] } },
      'https://api.example.com/items?active=true&skip=4&take=2': { body: { rows: [5] } },
    });
    const result = await loadRows(options(offset, fetchImpl, { arrayPath: 'rows' }));
    expect(result).toMatchObject({ rows: [1, 2, 3, 4, 5], pages: 3, arrayPath: 'rows' });
  });
});

describe('loadRows with cursors', () => {
  const cursor: PagingConfig = {
    type: 'cursor',
    cursorPath: 'meta.next_cursor',
    cursorParam: 'cursor',
    maxPages: 10,
  };

  it('sends each cursor until there is none', async () => {
    const fetchImpl = server({
      [request.url]: { body: { data: [1], meta: { next_cursor: 'b c' } } },
      'https://api.example.com/items?active=true&cursor=b%20c': {
        body: { data: [2], meta: { next_cursor: 42 } },
      },
      'https://api.example.com/items?active=true&cursor=42': {
        body: { data: [3], meta: { next_cursor: '' } },
      },
    });
    const result = await loadRows(options(cursor, fetchImpl));
    expect(result).toMatchObject({ rows: [1, 2, 3], pages: 3, truncated: false });
  });

  it('stops when a cursor repeats', async () => {
    const fetchImpl = server({
      [request.url]: { body: { data: [1], meta: { next_cursor: 'x' } } },
      'https://api.example.com/items?active=true&cursor=x': {
        body: { data: [2], meta: { next_cursor: 'x' } },
      },
    });
    const result = await loadRows(options(cursor, fetchImpl));
    expect(result).toMatchObject({ rows: [1, 2], pages: 2, truncated: false });
  });
});

describe('nextLinkFromHeader', () => {
  it('finds the next relation among several links', () => {
    expect(nextLinkFromHeader('<https://a/1>; rel="prev", <https://a/3>; rel="next"')).toBe(
      'https://a/3'
    );
    expect(nextLinkFromHeader('<https://a/3>; title="x, y"; REL="Next Last"')).toBe('https://a/3');
    expect(nextLinkFromHeader('<https://a/3,4>; rel=next')).toBe('https://a/3,4');
  });

  it('returns null when there’s no next link', () => {
    expect(nextLinkFromHeader(null)).toBeNull();
    expect(nextLinkFromHeader('')).toBeNull();
    expect(nextLinkFromHeader('<https://a/1>; rel="prev"')).toBeNull();
    expect(nextLinkFromHeader('<https://a/1; rel="next"')).toBeNull();
    expect(nextLinkFromHeader('<https://a/1>; rel="nextpage"')).toBeNull();
  });

  it('handles long hostile headers quickly', () => {
    const started = performance.now();
    nextLinkFromHeader('<'.repeat(100_000));
    nextLinkFromHeader(`<a>${'"'.repeat(100_000)}`);
    nextLinkFromHeader('<a>; rel=prev,'.repeat(20_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('withQueryParameter', () => {
  it('replaces one parameter and leaves the others as written', () => {
    expect(
      withQueryParameter('https://a.example/x?q=a%20b+c&page=1&ids%5B%5D=1', 'page', '2')
    ).toBe('https://a.example/x?q=a%20b+c&ids%5B%5D=1&page=2');
    expect(withQueryParameter('https://a.example/x', 'page size', 'a&b')).toBe(
      'https://a.example/x?page%20size=a%26b'
    );
  });
});
