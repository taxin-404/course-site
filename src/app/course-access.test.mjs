import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCourseAccess } from './course-access.ts';

test('add is a union: it merges the chosen courses, keeps the rest and never duplicates', () => {
  assert.deepEqual(applyCourseAccess(['A', 'B'], ['B', 'C'], 'add'), ['A', 'B', 'C']);
  assert.deepEqual(applyCourseAccess([], ['A'], 'add'), ['A']);
  assert.deepEqual(applyCourseAccess(['A'], [], 'add'), ['A'], 'adding nothing changes nothing');
});

test('remove is a difference: it drops only the chosen courses', () => {
  assert.deepEqual(applyCourseAccess(['A', 'B', 'C'], ['A', 'C'], 'remove'), ['B']);
  assert.deepEqual(applyCourseAccess(['A'], ['Z'], 'remove'), ['A'], 'removing an unheld course is a no-op');
  assert.deepEqual(applyCourseAccess(['A'], ['A'], 'remove'), []);
});

test('the existing order is preserved so the save is stable', () => {
  assert.deepEqual(applyCourseAccess(['B', 'A'], ['C'], 'add'), ['B', 'A', 'C']);
});
