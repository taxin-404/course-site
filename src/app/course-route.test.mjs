import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCourseTail, courseUrl, folderUrl, lessonUrl, encodeBracketsInPath } from './course-route.ts';

test('the course root is a browser at the course folder', () => {
  assert.deepEqual(parseCourseTail('Math', ''), { kind: 'browser', course: 'Math', path: [] });
  assert.deepEqual(parseCourseTail('Math', 'folder'), { kind: 'browser', course: 'Math', path: [] });
});

test('a folder URL becomes a browser at that path', () => {
  assert.deepEqual(parseCourseTail('Math', 'folder/Chapter 1/Section 2'), {
    kind: 'browser',
    course: 'Math',
    path: ['Chapter 1', 'Section 2'],
  });
});

test('a lesson URL names the lesson and the folder it lives in', () => {
  assert.deepEqual(parseCourseTail('Math', 'lesson/Chapter 1/video 1'), {
    kind: 'player',
    course: 'Math',
    lessonId: 'Math/Chapter 1/video 1',
    path: ['Chapter 1'],
  });
});

test('a top-level lesson has no folder path', () => {
  assert.deepEqual(parseCourseTail('Math', 'lesson/intro'), {
    kind: 'player',
    course: 'Math',
    lessonId: 'Math/intro',
    path: [],
  });
});

test('URL builders produce the commands the matcher reads back', () => {
  assert.deepEqual(courseUrl('Math'), ['/course', 'Math']);
  assert.deepEqual(folderUrl('Math', []), ['/course', 'Math']);
  assert.deepEqual(folderUrl('Math', ['A', 'B']), ['/course', 'Math', 'folder', 'A', 'B']);
  assert.deepEqual(lessonUrl('Math', 'Math/A/one'), ['/course', 'Math', 'lesson', 'A', 'one']);
});

test('a round trip survives names with spaces and unicode', () => {
  const path = ['Chapter 1', 'ভিডিও'];
  assert.deepEqual(parseCourseTail('গণিত', `folder/${path.join('/')}`), {
    kind: 'browser',
    course: 'গণিত',
    path,
  });
});

test('encodeBracketsInPath re-encodes brackets the edge decoded', () => {
  assert.equal(
    encodeBracketsInPath('/course/B%5CD%20Unit%20Course%205.0%20(26%20Batch)'),
    '/course/B%5CD%20Unit%20Course%205.0%20%2826%20Batch%29',
  );
});

test('encodeBracketsInPath leaves an ordinary or already-encoded path alone', () => {
  assert.equal(encodeBracketsInPath('/course/MERN%20Stack'), '/course/MERN%20Stack');
  assert.equal(encodeBracketsInPath('/course/a%28b%29'), '/course/a%28b%29');
  assert.equal(encodeBracketsInPath('/'), '/');
});
