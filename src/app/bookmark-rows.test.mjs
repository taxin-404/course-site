import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkRows } from './bookmark-rows.ts';

const lesson = (id, title, bookmarked, bookmarkedAt) => ({
  id, title, kind: 'video', done: false, bookmarked,
  ...(bookmarkedAt ? { bookmarkedAt } : {}),
});
const course = (title, sections) => ({ title, description: '', sections });

test('bookmarkRows keeps only bookmarked lessons and labels their section', () => {
  const rows = bookmarkRows([
    course('Course', [
      { title: null, lessons: [lesson('Course/root', 'Root', true, 10), lesson('Course/plain', 'Plain', false)] },
      { title: 'Week 1', lessons: [lesson('Course/Week 1/one', 'One', true, 30)] },
    ]),
    course('Other', [{ title: 'Hidden', lessons: [lesson('Other/hidden', 'Hidden', true, 20)] }]),
  ]);
  assert.deepEqual(rows.map((r) => [r.lesson, r.course, r.section]), [
    ['Course/Week 1/one', 'Course', 'Week 1'],
    ['Other/hidden', 'Other', 'Hidden'],
    ['Course/root', 'Course', ''],
  ]);
});

test('bookmarkRows gives equal timestamps a stable course/section/title order', () => {
  const rows = bookmarkRows([
    course('B', [{ title: 'S', lessons: [lesson('B/S/b', 'B lesson', true, 0)] }]),
    course('A', [{ title: 'S', lessons: [lesson('A/S/b', 'B lesson', true, 0), lesson('A/S/a', 'A lesson', true, 0)] }]),
  ]);

  assert.deepEqual(rows.map((r) => r.lesson), ['A/S/a', 'A/S/b', 'B/S/b']);
});

test('bookmarkRows shows nothing from a locked course payload', () => {
  assert.deepEqual(bookmarkRows([{ title: 'Locked', description: '', locked: true, sections: [] }]), []);
});
