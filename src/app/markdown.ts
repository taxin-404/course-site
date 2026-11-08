/**
 * A tiny, dependency-free Markdown renderer for `.md` resources and lessons.
 *
 * All HTML is escaped *before* anything is rendered, so file contents can never
 * inject markup. Only a small subset is supported: ATX headings, fenced code
 * blocks, unordered/ordered lists, blockquotes, horizontal rules, bold, italic,
 * inline code, and http/https links. Everything else is shown as literal text.
 */

/** Escape the characters that could otherwise become markup. `&` must go first. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Apply bold and italic/underscore emphasis to a run of plain text. */
function applyEmphasis(text: string): string {
  let out = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Require word boundaries so intraword underscores (snake_case) stay literal.
  out = out.replace(/(^|[^\w_])_([^_\s][^_]*?)_(?=$|[^\w_])/g, '$1<em>$2</em>');
  return out;
}

/** A marker (one or more NUL bytes) that does not occur in `text`, used to shield links. */
function uniqueMarker(text: string): string {
  let marker = '\u0000';
  while (text.includes(marker)) marker += '\u0000';
  return marker;
}

/**
 * Apply links and emphasis to a run of text that contains no inline code.
 * Each link is replaced by an opaque marker before the emphasis passes run, so
 * emphasis can span a link (`**[text](url)**`) while the passes never reach the
 * link's `href`; the rendered anchors are substituted back afterwards.
 */
function renderText(text: string): string {
  const links: string[] = [];
  const marker = uniqueMarker(text);
  const linkRe = /\[([^\]]*)\]\(([^)\s]*)\)/g;
  const withMarkers = text.replace(linkRe, (match, label: string, url: string) => {
    links.push(
      /^https?:\/\//i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${applyEmphasis(label)}</a>`
        : applyEmphasis(match),
    );
    return `${marker}${links.length - 1}${marker}`;
  });
  const tokenRe = new RegExp(`${marker}(\\d+)${marker}`, 'g');
  return applyEmphasis(withMarkers).replace(tokenRe, (_all, index: string) => links[Number(index)]);
}

/** Render one line's inline content. Splitting on backticks protects code from emphasis. */
function renderInline(text: string): string {
  const parts = text.split('`');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += i % 2 === 1 ? `<code>${parts[i]}</code>` : renderText(parts[i]);
  }
  return out;
}

/** True when a line begins a block, so a paragraph must stop before it. */
function isBlockStart(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    /^```/.test(t) ||
    /^#{1,6}\s+/.test(t) ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
    /^&gt;/.test(t) ||
    /^[-*+]\s+/.test(t) ||
    /^\d+\.\s+/.test(t)
  );
}

const listItem = (tag: 'ul' | 'ol', items: string[]): string =>
  `<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`;

/** Render Markdown `src` to a safe HTML string. Pure: no state, no dependencies. */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const content: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) content.push(lines[i++]);
      if (i < lines.length) i++; // consume the closing fence
      out.push(`<pre><code>${content.join('\n')}${content.length ? '\n' : ''}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^&gt;/.test(trimmed)) {
      const quoted: string[] = [];
      while (i < lines.length && /^&gt;/.test(lines[i].trim())) {
        quoted.push(lines[i].trim().replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(renderInline(lines[i].trim().replace(/^[-*+]\s+/, '')));
        i++;
      }
      out.push(listItem('ul', items));
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(renderInline(lines[i].trim().replace(/^\d+\.\s+/, '')));
        i++;
      }
      out.push(listItem('ol', items));
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) paragraph.push(lines[i++].trim());
    out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }

  return out.join('\n');
}
