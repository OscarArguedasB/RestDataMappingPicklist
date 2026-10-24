import type { PagingConfig } from './config';
import { LIMITS } from './config';
import { PicklistError } from './errors';
import { locateRows } from './items';
import { getByPath } from './path';
import type { SecurityPolicy } from './policy';
import { DEFAULT_POLICY, checkEndpoint } from './policy';
import type { FetchOptions, FetchedJson, PreparedRequest } from './request';
import { fetchJsonResponse } from './request';
import { isPlainObject } from './values';

export interface LoadRowsProgress {
  /** Every row loaded so far (a new array each time). */
  rows: readonly unknown[];
  /** Pages loaded so far. */
  page: number;
  done: boolean;
}

export interface LoadRowsOptions {
  request: PreparedRequest;
  /** Where the list is in each response. Empty: found automatically on the first page. */
  arrayPath: string;
  paging: PagingConfig;
  maxItems: number;
  maxPages: number;
  fetchOptions?: FetchOptions;
  /** Next-page links must pass this policy too. Default: DEFAULT_POLICY. */
  policy?: SecurityPolicy;
  onProgress?: (progress: LoadRowsProgress) => void;
}

export interface LoadRowsResult {
  rows: unknown[];
  pages: number;
  /** Stopped by maxItems or maxPages (or an unsafe next link) while more data existed. */
  truncated: boolean;
  /** The path actually used; detected when arrayPath was ''. */
  arrayPath: string;
  /** The first response, for the setup page's inspector. */
  firstResponse: unknown;
}

const LOG_PREFIX = '[REST picklist]';

/**
 * Body properties that commonly hold the next page's URL (OData, Microsoft Graph, JSON:API, HAL,
 * Facebook-style APIs). Only used when no path is configured, and only for values that look like
 * a link, so a cursor or page number stored under "next" is never mistaken for one.
 */
const WELL_KNOWN_NEXT_LINKS = [
  '@odata.nextLink',
  'odata.nextLink',
  'nextLink',
  'next_link',
  'nextPageUrl',
  'next',
  'links.next',
  '_links.next',
  'paging.next',
];

type NextPage = { kind: 'end' } | { kind: 'next'; url: string } | { kind: 'blocked'; why: string };

const END: NextPage = { kind: 'end' };

/** A whole number from 1 to `max`; callers normally pass effectiveLimits(), but never trust it. */
function positiveInteger(value: number, fallback: number, max: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.min(max, Math.floor(value)) : fallback;
}

function queryKey(pair: string): string {
  const separator = pair.indexOf('=');
  const raw = separator === -1 ? pair : pair.slice(0, separator);
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/**
 * Sets one query parameter, replacing any existing value. The other parameters are kept exactly as
 * they were written, because re-encoding them (say %20 as +) can change their meaning to a server.
 */
export function withQueryParameter(href: string, name: string, value: string): string {
  const url = new URL(href);
  const pairs = url.search
    .slice(1)
    .split('&')
    .filter((pair) => pair && queryKey(pair) !== name);
  pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  url.search = `?${pairs.join('&')}`;
  return url.href;
}

/** The target of the rel="next" link in a Link header (RFC 8288). One pass, no regex. */
export function nextLinkFromHeader(header: string | null): string | null {
  if (!header) {
    return null;
  }
  let index = 0;
  while (index < header.length) {
    const open = header.indexOf('<', index);
    const close = open === -1 ? -1 : header.indexOf('>', open + 1);
    if (close === -1) {
      return null;
    }
    // The link's parameters run to the next comma outside a quoted string.
    let end = close + 1;
    let quoted = false;
    while (end < header.length) {
      const char = header[end];
      if (char === '\\' && quoted) {
        end += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        break;
      }
      end += 1;
    }
    if (relationIncludesNext(header.slice(close + 1, end))) {
      return header.slice(open + 1, close).trim();
    }
    index = end + 1;
  }
  return null;
}

function relationIncludesNext(parameters: string): boolean {
  for (const parameter of parameters.split(';')) {
    const separator = parameter.indexOf('=');
    if (separator === -1 || parameter.slice(0, separator).trim().toLowerCase() !== 'rel') {
      continue;
    }
    let value = parameter.slice(separator + 1).trim();
    if (value.startsWith('"')) {
      value = value.slice(1, value.endsWith('"') ? -1 : undefined);
    }
    // Only the first rel parameter counts; it can list several relation types.
    return value.toLowerCase().split(' ').includes('next');
  }
  return false;
}

/** A link from the body: a string, or an object with an href (HAL, JSON:API). */
function linkValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  if (isPlainObject(value) && typeof value.href === 'string') {
    return value.href.trim() || null;
  }
  return null;
}

function looksLikeLink(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    value.startsWith('/') ||
    value.startsWith('?')
  );
}

function findNextLink(response: FetchedJson, configuredPath: string): string | null {
  if (configuredPath) {
    const configured = linkValue(getByPath(response.data, configuredPath));
    if (configured) {
      return configured;
    }
  } else {
    for (const path of WELL_KNOWN_NEXT_LINKS) {
      const found = linkValue(getByPath(response.data, path));
      if (found && looksLikeLink(found)) {
        return found;
      }
    }
  }
  return nextLinkFromHeader(response.headers.get('link'));
}

/**
 * Resolves a next-page link. It must stay on the first request's origin, because the same
 * credentials are sent with every page, and it must pass the organization's policy.
 */
function followLink(raw: string, base: string, origin: string, policy: SecurityPolicy): NextPage {
  let next: URL;
  try {
    next = new URL(raw, base);
  } catch {
    return { kind: 'blocked', why: 'the next page link isn’t a valid URL' };
  }
  next.hash = '';
  if (next.origin !== origin) {
    return { kind: 'blocked', why: `the next page is on another site (${next.origin})` };
  }
  if (next.username || next.password) {
    return { kind: 'blocked', why: 'the next page link contains a user name or password' };
  }
  const problem = checkEndpoint(next, policy);
  return problem ? { kind: 'blocked', why: problem } : { kind: 'next', url: next.href };
}

function numberedPageUrl(base: string, paging: PagingConfig, index: number): string {
  switch (paging.type) {
    case 'page':
      return withQueryParameter(
        withQueryParameter(base, paging.pageParam, String(paging.startPage + index)),
        paging.sizeParam,
        String(paging.size)
      );
    case 'offset':
      return withQueryParameter(
        withQueryParameter(base, paging.offsetParam, String(index * paging.limit)),
        paging.limitParam,
        String(paging.limit)
      );
    default:
      return base;
  }
}

/** Rows of a page after the first. A page without the list ends paging instead of failing. */
function laterPageRows(data: unknown, arrayPath: string): unknown[] {
  if (!arrayPath) {
    return Array.isArray(data) ? data : [];
  }
  try {
    return locateRows(data, arrayPath).rows;
  } catch (error) {
    if (error instanceof PicklistError) {
      return [];
    }
    throw error;
  }
}

function cancelled(): PicklistError {
  return new PicklistError('aborted', 'The request was cancelled.');
}

/**
 * Loads the rows of a list, following the configured paging until the list ends or a limit is
 * reached. Every page is sent with the same headers, to the first request's origin only.
 */
export async function loadRows(options: LoadRowsOptions): Promise<LoadRowsResult> {
  const { request, paging, fetchOptions, onProgress } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  const signal = fetchOptions?.signal;
  const maxItems = positiveInteger(options.maxItems, LIMITS.maxItems.default, LIMITS.maxItems.max);
  const maxPages =
    paging.type === 'none'
      ? 1
      : positiveInteger(options.maxPages, LIMITS.maxPages.default, LIMITS.maxPages.max);

  const problem = checkEndpoint(request.url, policy);
  if (problem) {
    throw new PicklistError('config', problem);
  }
  const origin = new URL(request.url).origin;

  const rows: unknown[] = [];
  const requested = new Set<string>();
  const cursors = new Set<string>();
  let url = numberedPageUrl(request.url, paging, 0);
  let arrayPath = options.arrayPath.trim();
  let firstResponse: unknown = null;
  let pages = 0;
  let truncated = false;

  const nextPage = (response: FetchedJson, pageRowCount: number): NextPage => {
    switch (paging.type) {
      case 'nextLink': {
        const raw = findNextLink(response, paging.nextLink);
        return raw ? followLink(raw, response.url, origin, policy) : END;
      }
      case 'page':
      case 'offset': {
        const size = paging.type === 'page' ? paging.size : paging.limit;
        // A short page is the last one.
        return pageRowCount < size
          ? END
          : { kind: 'next', url: numberedPageUrl(request.url, paging, pages) };
      }
      case 'cursor': {
        const value = getByPath(response.data, paging.cursorPath);
        const cursor =
          typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
        if (!cursor || cursors.has(cursor)) {
          return END;
        }
        cursors.add(cursor);
        return { kind: 'next', url: withQueryParameter(request.url, paging.cursorParam, cursor) };
      }
      default:
        return END;
    }
  };

  for (;;) {
    if (signal?.aborted) {
      throw cancelled();
    }
    requested.add(url);
    const response = await fetchJsonResponse({ ...request, url }, fetchOptions);
    pages += 1;
    let pageRows: unknown[];
    if (pages === 1) {
      firstResponse = response.data;
      const located = locateRows(response.data, arrayPath);
      arrayPath = located.path;
      pageRows = located.rows;
    } else {
      pageRows = laterPageRows(response.data, arrayPath);
    }

    const room = maxItems - rows.length;
    for (const row of pageRows.length > room ? pageRows.slice(0, room) : pageRows) {
      rows.push(row);
    }
    onProgress?.({ rows: rows.slice(), page: pages, done: false });

    if (pageRows.length > room) {
      truncated = true;
      break;
    }
    if (pageRows.length === 0 || paging.type === 'none') {
      break;
    }
    const next = nextPage(response, pageRows.length);
    if (next.kind === 'end') {
      break;
    }
    if (rows.length >= maxItems || pages >= maxPages) {
      truncated = true;
      break;
    }
    if (next.kind === 'blocked') {
      // Credentials are never sent to the link; the rows so far are still shown.
      console.warn(`${LOG_PREFIX} Stopped after page ${pages} because ${next.why}.`);
      truncated = true;
      break;
    }
    if (requested.has(next.url)) {
      console.warn(
        `${LOG_PREFIX} Stopped after page ${pages} because the next page repeats an earlier one.`
      );
      break;
    }
    url = next.url;
  }

  onProgress?.({ rows: rows.slice(), page: pages, done: true });
  return { rows, pages, truncated, arrayPath, firstResponse };
}
