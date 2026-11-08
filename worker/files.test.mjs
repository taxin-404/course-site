import test from 'node:test';
import assert from 'node:assert/strict';
import { isLessonKey, hasReservedSegment, ancestorScopes, childDirsFromIds } from './files.js';

const IDS = [
  'Course/ক্লাস করার নিয়ম/Vedio',   // folder directly under the course
  'Course/Section/Sub/lesson',       // nested -> only the top segment
  'Course/top-level-lesson',         // directly in Course -> not a folder
  'Other/Thing/x',                   // another course -> excluded
];

test('childDirsFromIds finds folder segments under the parent', () => {
  assert.deepEqual(childDirsFromIds('Course', IDS), ['Course/ক্লাস করার নিয়ম', 'Course/Section']);
  assert.deepEqual(childDirsFromIds('Course/Section', IDS), ['Course/Section/Sub']);
  assert.deepEqual(childDirsFromIds('', IDS), ['Course', 'Other']);
});

test('childDirsFromIds never treats a lesson in place, or _resources, as a folder', () => {
  assert.deepEqual(childDirsFromIds('C', ['C/lesson', 'C/_resources/x']), []);
});

test('isLessonKey accepts text and markdown lessons but never a shared RESOURCE file', () => {
  assert.equal(isLessonKey('C/lesson.txt'), true);
  assert.equal(isLessonKey('C/lesson.md'), true);
  assert.equal(isLessonKey('C/lesson.markdown'), true);
  assert.equal(isLessonKey('C/clip.ts'), false);
  assert.equal(isLessonKey('C/RESOURCE/syllabus.pdf'), false);
  assert.equal(isLessonKey('C/Module/RESOURCE/x.md'), false);
});

test('hasReservedSegment matches RESOURCE case-insensitively per whole segment', () => {
  assert.equal(hasReservedSegment('C/RESOURCE/x.pdf'), true);
  assert.equal(hasReservedSegment('C/Resource/x.pdf'), true);
  assert.equal(hasReservedSegment('C/resource/x.pdf'), true);
  assert.equal(hasReservedSegment('C/my-resources/x.pdf'), false);
  assert.equal(hasReservedSegment('C/RESOURCES/x.pdf'), false);
});

test('ancestorScopes lists folder prefixes nearest first', () => {
  assert.deepEqual(ancestorScopes('A/B/C/x.pdf'), ['A/B/C', 'A/B', 'A']);
});

test('childDirsFromIds never invents a RESOURCE folder from a YouTube id', () => {
  assert.deepEqual(childDirsFromIds('C', ['C/RESOURCE/x']), []);
});
