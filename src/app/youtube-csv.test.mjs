// The CSV import is the only way to add a whole YouTube course at once, and its rules are
// pure, so they are pinned here: which column is the link, which is the name, and — since a
// spreadsheet export carries a `no.` column — which column (if any) sets the lesson order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvPayload, parseYoutubeCsv } from './youtube-csv.ts';

const A = 'https://youtu.be/aaaaaaaaaa';
const B = 'https://youtu.be/bbbbbbbbbb';

test('reads "no.","name","link" and returns the rows in no. order', () => {
  const csv = `"no.","name","link"\n"2","Fractions","${B}"\n"1","Algebra","${A}"`;
  const { rows, rejected } = parseYoutubeCsv(csv);
  assert.deepEqual(rows.map((r) => [r.no, r.name]), [[1, 'Algebra'], [2, 'Fractions']]);
  assert.deepEqual(rejected, []);
});

test('a headerless column of unique numbers orders the rows too', () => {
  const csv = `2,Fractions,${B}\n1,Algebra,${A}`;
  assert.deepEqual(parseYoutubeCsv(csv).rows.map((r) => r.name), ['Algebra', 'Fractions']);
});

test('a repeated, blank or out-of-range number keeps file order and clears no', () => {
  const dup = `"no.","name","link"\n"1","A","${A}"\n"1","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(dup).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
  const blank = `"no.","name","link"\n"1","A","${A}"\n"","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(blank).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
  const big = `"no.","name","link"\n"10000","A","${A}"\n"2","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(big).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
});

test('dates and a repeated year are never read as the order', () => {
  const dates = `2026-01-05,B,${B}\n2026-01-08,A,${A}`;
  assert.deepEqual(parseYoutubeCsv(dates).rows.map((r) => [r.name, r.no]), [['B', null], ['A', null]]);
  const years = `2026,B,${B}\n2026,A,${A}`;
  assert.deepEqual(parseYoutubeCsv(years).rows.map((r) => [r.name, r.no]), [['B', null], ['A', null]]);
});

test('a quoted name with a comma keeps its place in the order', () => {
  const csv = `"no.","name","link"\n"2","Fractions, part 2","${B}"\n"1","Algebra","${A}"`;
  assert.deepEqual(parseYoutubeCsv(csv).rows.map((r) => r.name), ['Algebra', 'Fractions, part 2']);
});

test('the rejection rules are unchanged', () => {
  const csv = `"no.","name","link"\n"1","A/B","${A}"\n"2","","${B}"\n"3","C","https://example.com/x"`;
  const { rows, rejected } = parseYoutubeCsv(csv);
  assert.deepEqual(rows, []);
  assert.deepEqual(rejected.map((r) => r.line), [2, 3, 4]);
});

test('csvPayload sends the numbered batch as ordered', () => {
  const csv = `"no.","name","link"\n"1","A","${A}"\n"2","B","${B}"`;
  const { lessons, ordered } = csvPayload(parseYoutubeCsv(csv).rows);
  assert.equal(ordered, true);
  assert.deepEqual(lessons, [{ lesson: 'A', link: A }, { lesson: 'B', link: B }]);
});

test('csvPayload keeps file order when the numbers are unusable', () => {
  const csv = `B,${B}\nA,${A}`;
  const { lessons, ordered } = csvPayload(parseYoutubeCsv(csv).rows);
  assert.equal(ordered, false);
  assert.deepEqual(lessons.map((l) => l.lesson), ['B', 'A']);
});
