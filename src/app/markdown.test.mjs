import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

test('markdown escapes HTML before rendering anything', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'));
  assert.match(out, /&lt;script&gt;/);
});

test('markdown renders headings, lists, fences and emphasis', () => {
  const out = renderMarkdown('# Title\n\n- one\n- two\n\n```\ncode & <b>\n```\n\n**bold** and *italic* and `x<y`');
  assert.match(out, /<h1[^>]*>Title<\/h1>/);
  assert.match(out, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ul>/);
  assert.match(out, /<pre><code>[\s\S]*code &amp; &lt;b&gt;[\s\S]*<\/code><\/pre>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<code>x&lt;y<\/code>/);
});

test('markdown links allow only http/https and set rel/target', () => {
  const ok = renderMarkdown('[site](https://example.com/a)');
  assert.match(ok, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">site<\/a>/);
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('href') && !bad.includes('<a '));
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/);
});

test('markdown link hrefs are not corrupted by emphasis', () => {
  for (const url of ['https://e.com/_foo_', 'https://e.com/_foo_bar_', 'https://e.com/*foo*', 'https://e.com/__foo__']) {
    const out = renderMarkdown(`[x](${url})`);
    const href = /href="([^"]*)"/.exec(out);
    assert.ok(href, `no href for ${url}`);
    assert.equal(href[1], url);
    assert.ok(!out.includes('<em>') && !out.includes('<strong>'), `emphasis leaked into ${url}: ${out}`);
  }
});
