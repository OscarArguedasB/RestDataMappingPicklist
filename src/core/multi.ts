// Several values stored in one text field, “A; B; C”, and the text/HTML conversions needed to read
// them from (and write them to) multi-line fields, which hold HTML.

/** Between values when several are stored in one field. */
export const MULTI_VALUE_SEPARATOR = '; ';

/** Characters a Text (single line) field holds. */
export const SINGLE_LINE_TEXT_LIMIT = 255;

/**
 * Reads “A; B; C” into its values: split on ';', trimmed, blanks dropped, each value once (in the
 * order first seen). A value that itself contains ';' can't be stored this way.
 */
export function parseMultiValue(text: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const part of (text ?? '').split(';')) {
    const value = part.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

/** Writes values as “A; B; C”, trimmed, without blanks or repeats, so parseMultiValue reads them back. */
export function formatMultiValue(values: readonly string[]): string {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      kept.push(value);
    }
  }
  return kept.join(MULTI_VALUE_SEPARATOR);
}

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** Text safe to put inside HTML, as element content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES.get(character) ?? character);
}

// Named character references decoded by htmlToPlainText: the ones rich-text editors write, plus
// Latin-1 (U+00A0–U+00FF, in code point order) for accented letters. A Map, so names such as
// “constructor” never reach Object.prototype.
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['zwnj', '‌'],
  ['zwj', '‍'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['sbquo', '‚'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['bdquo', '„'],
  ['lsaquo', '‹'],
  ['rsaquo', '›'],
  ['bull', '•'],
  ['hellip', '…'],
  ['prime', '′'],
  ['Prime', '″'],
  ['dagger', '†'],
  ['Dagger', '‡'],
  ['permil', '‰'],
  ['trade', '™'],
  ['euro', '€'],
  ['larr', '←'],
  ['rarr', '→'],
  ['uarr', '↑'],
  ['darr', '↓'],
  ['OElig', 'Œ'],
  ['oelig', 'œ'],
  ['Scaron', 'Š'],
  ['scaron', 'š'],
  ['Yuml', 'Ÿ'],
  ['fnof', 'ƒ'],
  ['circ', 'ˆ'],
  ['tilde', '˜'],
]);
const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml ' +
  'Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times ' +
  'Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ' +
  'ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ' +
  'ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
for (const [offset, name] of LATIN1_NAMES.split(' ').entries()) {
  NAMED_ENTITIES.set(name, String.fromCodePoint(0xa0 + offset));
}

/** Elements that separate text, so “<p>A</p><p>B</p>” reads “A B” rather than “AB”. */
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Elements whose content is code, not text. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

const MAX_ENTITY_NAME = 32;

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isNameCharacter(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 45 /* - */ || code === 58; /* : */
}

function isSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/** Reads the tag starting at `start` ('<'). Returns where it ends and its lowercase name. */
function readTag(html: string, start: number): { end: number; name: string; closing: boolean } {
  let index = start + 1;
  const closing = html[index] === '/';
  if (closing) {
    index++;
  }
  const nameStart = index;
  if (isAsciiLetter(html.charCodeAt(index))) {
    while (index < html.length && isNameCharacter(html.charCodeAt(index))) {
      index++;
    }
  }
  const name = html.slice(nameStart, index).toLowerCase();
  // Find the closing '>', skipping quoted attribute values (they may contain '>').
  let quote = '';
  let afterEquals = false;
  for (; index < html.length; index++) {
    const character = html[index] ?? '';
    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '>') {
      return { end: index + 1, name, closing };
    }
    if ((character === '"' || character === "'") && afterEquals) {
      quote = character;
      afterEquals = false;
    } else if (character === '=') {
      afterEquals = true;
    } else if (!isSpace(character)) {
      afterEquals = false;
    }
  }
  // An unfinished tag at the end is dropped, as browsers do.
  return { end: html.length, name, closing };
}

/** Skips the content of <script>/<style>: returns the index after its closing tag. */
function skipRawText(html: string, from: number, name: string): number {
  for (let at = html.indexOf('</', from); at !== -1; at = html.indexOf('</', at + 2)) {
    const nameEnd = at + 2 + name.length;
    if (
      html.slice(at + 2, nameEnd).toLowerCase() === name &&
      !isNameCharacter(html.charCodeAt(nameEnd))
    ) {
      return readTag(html, at).end;
    }
  }
  return html.length;
}

/** Decodes the character reference starting at `start` ('&'); null when it isn't one. */
function readEntity(html: string, start: number): { text: string; end: number } | null {
  let index = start + 1;
  if (html[index] === '#') {
    index++;
    const hex = html[index] === 'x' || html[index] === 'X';
    if (hex) {
      index++;
    }
    const digitsStart = index;
    const isDigit = hex ? isHexDigit : isAsciiDigit;
    // Enough digits for every code point (10FFFF, 1114111); longer runs aren't decoded.
    const maxDigits = hex ? 6 : 7;
    while (
      index < html.length &&
      index - digitsStart < maxDigits &&
      isDigit(html.charCodeAt(index))
    ) {
      index++;
    }
    if (index === digitsStart || html[index] !== ';') {
      return null;
    }
    const code = Number.parseInt(html.slice(digitsStart, index), hex ? 16 : 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return { text: valid ? String.fromCodePoint(code) : '�', end: index + 1 };
  }
  const nameStart = index;
  while (
    index < html.length &&
    index - nameStart < MAX_ENTITY_NAME &&
    (isAsciiLetter(html.charCodeAt(index)) || isAsciiDigit(html.charCodeAt(index)))
  ) {
    index++;
  }
  if (index === nameStart || html[index] !== ';') {
    return null;
  }
  const text = NAMED_ENTITIES.get(html.slice(nameStart, index));
  return text === undefined ? null : { text, end: index + 1 };
}

/**
 * The text of an HTML fragment, as one line: tags and comments removed (script and style content
 * too), common character references decoded, whitespace collapsed, trimmed. A single left-to-right
 * pass with no regular expressions over the markup, so hostile input can't make it slow. The
 * result is plain text: show it as text, never as HTML.
 */
export function htmlToPlainText(html: string): string {
  const source = html ?? '';
  const parts: string[] = [];
  let index = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      parts.push(source.slice(textStart, end));
    }
  };
  while (index < source.length) {
    const character = source[index];
    if (character === '<') {
      const next = source.charCodeAt(index + 1);
      if (source.startsWith('<!--', index)) {
        flushText(index);
        const end = source.indexOf('-->', index + 4);
        index = end === -1 ? source.length : end + 3;
        textStart = index;
        continue;
      }
      // '<' starts markup only before a letter, '/', '!' or '?'; otherwise it's text ("a < b").
      if (isAsciiLetter(next) || next === 47 || next === 33 || next === 63) {
        flushText(index);
        const tag = readTag(source, index);
        if (BLOCK_ELEMENTS.has(tag.name)) {
          parts.push(' ');
        }
        index =
          !tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)
            ? skipRawText(source, tag.end, tag.name)
            : tag.end;
        textStart = index;
        continue;
      }
    } else if (character === '&') {
      const entity = readEntity(source, index);
      if (entity) {
        flushText(index);
        parts.push(entity.text);
        index = entity.end;
        textStart = index;
        continue;
      }
    }
    index++;
  }
  flushText(source.length);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
