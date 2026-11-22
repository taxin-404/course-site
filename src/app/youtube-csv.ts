/**
 * CSV import for YouTube lessons.
 *
 * The Files view lets an admin add many lessons at once from a CSV file. This
 * module is pure (no Angular) so its rules can be checked on their own.
 *
 * Format: comma-separated, RFC-4180 quoting (`"…"`, with `""` for a literal
 * quote, and commas or newlines allowed inside quotes), LF or CRLF, and an
 * optional leading UTF-8 BOM. Columns are detected rather than fixed, so extra
 * columns (a row number, a date) are simply ignored: the link column is the one
 * whose cells are most often YouTube links, and the name is the column just to
 * its left (to its right, when the link is the first column). A header row is
 * optional and is detected by holding no YouTube *URL* (a bare video id can look
 * like a header word).
 *
 * A `no.` column (the usual spreadsheet export) sets the order: the rows come
 * back sorted by it. It is only trusted when every data row holds a different
 * whole number from 1 to 9999; otherwise the column is ignored and file order
 * stands, so a hand-edited blank cell never loses or reorders a lesson.
 */

export interface CsvRow { name: string; link: string; yt: string; no: number | null }
export interface CsvReject { line: number; reason: string }

/** Header words that name a row-number column (compared after `headerName`). */
const NO_HEADERS = new Set(['no', 'nr', 'number', '#', 'order', 'position', 'pos', 'sn', 's.no', 'sr.no']);
const headerName = (cell: string): string => cell.trim().toLowerCase().replace(/\s+/g, '').replace(/\.+$/, '');

/** The whole number in one cell, if it can be a lesson position. */
function orderAt(cells: string[], col: number): number | null {
  const raw = (cells[col] ?? '').trim();
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 9999 ? n : null;
}

/** One column's numbers, or null when any cell is not a distinct usable number. */
function orderColumn(data: string[][], col: number): number[] | null {
  const nums = data.map((cells) => orderAt(cells, col));
  if (nums.some((n) => n === null)) return null;
  const out = nums as number[];
  return new Set(out).size === out.length ? out : null;
}

/** The URL part of a YouTube link (watch, youtu.be, /embed, /shorts, /live). */
const YT_URL = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{6,})/;
const BARE_ID = /^[A-Za-z0-9_-]{6,}$/;

/** True when the text is a YouTube URL (as opposed to a bare video id). */
function isYoutubeUrl(s: string): boolean { return YT_URL.test(String(s ?? '').trim()); }

/** The video id in any usual YouTube link (watch, youtu.be, /embed, /shorts, /live), or a bare id. */
export function ytId(link: string): string | null {
  const s = String(link ?? '').trim();
  if (!s) return null;
  const m = YT_URL.exec(s);
  if (m) return m[1];
  return BARE_ID.test(s) ? s : null;
}

/** Split CSV text into rows of cells (RFC-4180), dropping a leading BOM. */
function splitCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } // "" is one literal quote
        else quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Parse a CSV file into lessons.
 *
 * A header row is optional (detected by holding no YouTube link). Rows that have
 * no name, a name containing `/`, or a link that is not YouTube are reported in
 * `rejected` and skipped; every other row is returned in `rows`.
 */
export function parseYoutubeCsv(text: string): { rows: CsvRow[]; rejected: CsvReject[] } {
  const all = splitCsv(text).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (!all.length) return { rows: [], rejected: [] };
  // A header row holds no YouTube *URL*. A bare video id is not enough: a header
  // word such as "Youtube" is >= 6 id-like characters and would otherwise be
  // read as one, so only a real URL (watch/youtu.be/embed/shorts/live) counts here.
  const header = !all[0].some((c) => isYoutubeUrl(c));
  const data = header ? all.slice(1) : all;
  if (!data.length) return { rows: [], rejected: [] };

  const width = data.reduce((n, r) => Math.max(n, r.length), 0);
  // URL hits outrank bare-id hits: a word like "Fractions" is id-shaped, so a name
  // column and a bare-id link column would otherwise tie and the first could win.
  let linkCol = 0;
  let bestUrl = -1;
  let bestId = -1;
  for (let i = 0; i < width; i++) {
    let urls = 0;
    let ids = 0;
    for (const r of data) {
      const cell = (r[i] ?? '').trim();
      if (!ytId(cell)) continue;
      if (isYoutubeUrl(cell)) urls++;
      else ids++;
    }
    if (urls > bestUrl || (urls === bestUrl && ids > bestId)) {
      bestUrl = urls; bestId = ids; linkCol = i;
    }
  }
  const nameCol = linkCol > 0 ? linkCol - 1 : linkCol + 1;

  // A named `no.` column wins; without a header, take the leftmost column that
  // happens to hold 1..N. A repeated value (a year) or a non-number (a date)
  // disqualifies the column, which is what keeps those exports in file order.
  let numbers: number[] | null = null;
  if (header) {
    const at = all[0].findIndex((c) => NO_HEADERS.has(headerName(c)));
    if (at >= 0) numbers = orderColumn(data, at);
  } else {
    for (let i = 0; i < width; i++) {
      if (i === linkCol || i === nameCol) continue;
      const found = orderColumn(data, i);
      if (found) { numbers = found; break; }
    }
  }

  const rows: CsvRow[] = [];
  const rejected: CsvReject[] = [];
  data.forEach((cells, idx) => {
    const line = idx + (header ? 2 : 1);
    const name = (cells[nameCol] ?? '').trim();
    const link = (cells[linkCol] ?? '').trim();
    const yt = ytId(link);
    if (!name) rejected.push({ line, reason: 'no name' });
    else if (name.includes('/')) rejected.push({ line, reason: 'name contains "/"' });
    else if (!yt) rejected.push({ line, reason: 'not a YouTube link' });
    else rows.push({ name, link, yt, no: numbers ? numbers[idx] : null });
  });
  if (numbers) rows.sort((a, b) => (a.no as number) - (b.no as number));
  return { rows, rejected };
}
