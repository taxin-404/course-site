import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_HINT_MS, hintKey, shouldShowHint, markHintSeen } from './pdf-hint.ts';

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
};

test('the hint lasts ten seconds', () => assert.equal(PDF_HINT_MS, 10_000));

test('the key is per student', () => {
  assert.equal(hintKey(7), 'pdf-hint-seen:7');
  assert.notEqual(hintKey(7), hintKey(8));
});

test('show until this student has seen it', () => {
  const s = store();
  assert.equal(shouldShowHint(s, 7), true);
  markHintSeen(s, 7);
  assert.equal(shouldShowHint(s, 7), false);
});

test('one student seeing it does not hide it for another', () => {
  const s = store();
  markHintSeen(s, 7);
  assert.equal(shouldShowHint(s, 7), false);
  assert.equal(shouldShowHint(s, 8), true);
});

test('no signed-in id means no hint', () => {
  const s = store();
  assert.equal(shouldShowHint(s, undefined), false);
  assert.equal(shouldShowHint(s, null), false);
  assert.equal(shouldShowHint(s, ''), false);
});

test('a storage that throws never breaks the viewer', () => {
  const bad = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(shouldShowHint(bad, 7), false);
  assert.doesNotThrow(() => markHintSeen(bad, 7));
});
