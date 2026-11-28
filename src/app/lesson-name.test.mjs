import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonName } from './lesson-name.ts';

const M = '\u200B';

test('lessonName is the last segment of the id', () => {
  assert.equal(lessonName('Course/Chapter 6/Live Class'), 'Live Class');
});

test('lessonName strips the hidden duplicate ordinal', () => {
  assert.equal(lessonName(`Course/Chapter 6/Live Class${M}2`), 'Live Class');
  assert.equal(lessonName(`Course/Live Class${M}12`), 'Live Class');
});

test('lessonName keeps a number the name itself ends with', () => {
  assert.equal(lessonName('Course/Live Class 2'), 'Live Class 2');
  assert.equal(lessonName('Course/2'), '2');
});