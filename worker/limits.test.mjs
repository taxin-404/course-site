import test from 'node:test';
import assert from 'node:assert/strict';
import { hourBucket, lessonOf, publicLesson } from './limits.js';

test('lessonOf folds HLS parts into the lesson they belong to', () => {
  assert.equal(lessonOf('Course/Sec/lesson.mp4'), 'Course/Sec/lesson.mp4');
  assert.equal(lessonOf('Course/Sec/Video/index.m3u8'), 'Course/Sec/Video');
  assert.equal(lessonOf('Course/Sec/Video/index.en.vtt'), 'Course/Sec/Video');
  assert.equal(lessonOf('Course/Sec/Video/segment_003.ts'), 'Course/Sec/Video');
  // The extension match is case-insensitive, like the media route.
  assert.equal(lessonOf('Course/Sec/Video/INDEX.M3U8'), 'Course/Sec/Video');
});

test('hourBucket groups by the hour and rolls over at the boundary', () => {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(hourBucket(base), hourBucket(base + 59 * 60e3));
  assert.notEqual(hourBucket(base), hourBucket(base + 36e5));
});

test('publicLesson never exposes the YouTube id but keeps what a student needs', () => {
  const yt = publicLesson({ id: 'Course/Sec/Clip', title: 'Clip', kind: 'youtube', yt: 'dQw4w9WgXcQ' }, true);
  assert.deepEqual(yt, { id: 'Course/Sec/Clip', title: 'Clip', kind: 'youtube', done: true, bookmarked: false });
  assert.ok(!('yt' in yt));

  const hls = publicLesson({ id: 'Course/Sec/V', title: 'V', kind: 'video', subtitles: [{ key: 'k', lang: 'en' }] }, false);
  assert.deepEqual(hls, {
    id: 'Course/Sec/V', title: 'V', kind: 'video', done: false, bookmarked: false,
    subtitles: [{ key: 'k', lang: 'en' }],
  });

  const saved = publicLesson({ id: 'Course/Sec/V', title: 'V', kind: 'video' }, false, 1730000000000);
  assert.deepEqual(saved, {
    id: 'Course/Sec/V', title: 'V', kind: 'video', done: false,
    bookmarked: true, bookmarkedAt: 1730000000000,
  });
});
