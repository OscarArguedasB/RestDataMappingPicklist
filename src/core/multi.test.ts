import { describe, expect, it } from 'vitest';
import {
  MULTI_VALUE_SEPARATOR,
  SINGLE_LINE_TEXT_LIMIT,
  escapeHtml,
  formatMultiValue,
  htmlToPlainText,
  parseMultiValue,
} from './multi';

describe('multiple values', () => {
  it('splits on semicolons, trims, drops blanks and repeats', () => {
    expect(parseMultiValue(' A ;B;; ;A; C ')).toEqual(['A', 'B', 'C']);
    expect(parseMultiValue('')).toEqual([]);
    expect(parseMultiValue('   ')).toEqual([]);
    expect(parseMultiValue('Only')).toEqual(['Only']);
  });

  it('keeps values that differ only in case', () => {
    expect(parseMultiValue('a; A')).toEqual(['a', 'A']);
  });

  it('writes values joined with “; ” and reads them back', () => {
    expect(MULTI_VALUE_SEPARATOR).toBe('; ');
    expect(formatMultiValue(['A', ' B ', '', 'A', 'C'])).toBe('A; B; C');
    expect(formatMultiValue([])).toBe('');
    const values = ['Ana Pérez', 'Bo', 'x-1'];
    expect(parseMultiValue(formatMultiValue(values))).toEqual(values);
  });

  it('knows how much a single-line text field holds', () => {
    expect(SINGLE_LINE_TEXT_LIMIT).toBe(255);
  });
});

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
    expect(escapeHtml('plain')).toBe('plain');
  });

  it('round-trips through htmlToPlainText', () => {
    const text = `A & B; <C> "D" 'E'`;
    expect(htmlToPlainText(escapeHtml(text))).toBe(text);
  });
});

describe('htmlToPlainText', () => {
  it('strips tags and keeps block boundaries as spaces', () => {
    expect(htmlToPlainText('<div>Alpha; <b>Beta</b></div><div>Gamma</div>')).toBe(
      'Alpha; Beta Gamma'
    );
    expect(htmlToPlainText('A<br>B<br/>C')).toBe('A B C');
    expect(htmlToPlainText('<p>One</p><p>Two</p>')).toBe('One Two');
    expect(htmlToPlainText('Bo<span>ld</span>')).toBe('Bold');
  });

  it('decodes named and numeric character references', () => {
    expect(htmlToPlainText('Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;x&#39;')).toBe(
      `Tom & Jerry <3 "hi" 'x'`
    );
    expect(htmlToPlainText('Caf&eacute; &Eacute;t&eacute; &yuml; &times; &nbsp;&copy;')).toBe(
      'Café Été ÿ × ©'
    );
    expect(htmlToPlainText('&#65;&#x42;&#X43; &#128512; &#0; &#xD800; &#1114112;')).toBe(
      'ABC 😀 � � �'
    );
    expect(htmlToPlainText('&hellip;&rsquo;&mdash;')).toBe('…’—');
  });

  it('leaves unknown or unfinished references alone', () => {
    expect(htmlToPlainText('AT&T &unknown; &amp &#; &#x; &constructor; &#12345678;')).toBe(
      'AT&T &unknown; &amp &#; &#x; &constructor; &#12345678;'
    );
  });

  it('does not turn decoded text back into markup', () => {
    expect(htmlToPlainText('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
  });

  it('treats a lone “<” as text', () => {
    expect(htmlToPlainText('a < b and c <= d, 1<2')).toBe('a < b and c <= d, 1<2');
  });

  it('skips comments, script and style content, and quoted “>” in attributes', () => {
    expect(
      htmlToPlainText(
        'A<!-- hidden -->B<script>alert("<b>x</b>")</script>C<style>p{}</style>D<a title="x>y">E</a>'
      )
    ).toBe('ABCDE');
    expect(htmlToPlainText('<SCRIPT type="x">bad()</SCRIPT >ok')).toBe('ok');
    expect(htmlToPlainText('<!DOCTYPE html><?xml version="1.0"?>Text')).toBe('Text');
  });

  it('drops unfinished markup at the end', () => {
    expect(htmlToPlainText('Text<!-- never closed')).toBe('Text');
    expect(htmlToPlainText('Text<b class="x')).toBe('Text');
    expect(htmlToPlainText('Text<script>forever')).toBe('Text');
  });

  it('collapses whitespace and trims', () => {
    expect(htmlToPlainText('  A \n\t B  C  ')).toBe('A B C');
    expect(htmlToPlainText('')).toBe('');
  });

  it('stays fast on hostile input', () => {
    const inputs = [
      '<'.repeat(100_000),
      '<a '.repeat(50_000),
      '&'.repeat(100_000),
      '&#'.repeat(50_000),
      '<a title="'.repeat(20_000),
      `<script>${'</scrip'.repeat(20_000)}`,
      '<!--'.repeat(50_000),
      '&amp'.repeat(50_000),
    ];
    const started = performance.now();
    for (const input of inputs) {
      htmlToPlainText(input);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
