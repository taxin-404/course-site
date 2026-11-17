import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_INDEX_KEY,
  isRestoredLoad,
  readNavIndex,
  resolveNavIndex,
  writeNavIndex,
} from './nav-index.ts';

const entry = (over = {}) => ({
  stateNav: undefined,
  seenIndex: -1,
  rememberedIndex: null,
  restored: false,
  ...over,
});

test('a tagged entry keeps the position it carries', () => {
  assert.equal(
    resolveNavIndex(entry({ stateNav: 3, seenIndex: 0, rememberedIndex: 1 })),
    3,
  );
});

test('a fresh navigation in this document continues from the last position', () => {
  assert.equal(resolveNavIndex(entry({ seenIndex: 0 })), 1);
  assert.equal(resolveNavIndex(entry({ seenIndex: 4 })), 5);
});

test('the first entry of a tab opened cold is position 0', () => {
  assert.equal(resolveNavIndex(entry()), 0);
});

test('a refresh restores the position this tab remembered', () => {
  assert.equal(resolveNavIndex(entry({ restored: true, rememberedIndex: 3 })), 3);
});

test('a refresh at the start of the history stays position 0', () => {
  assert.equal(resolveNavIndex(entry({ restored: true, rememberedIndex: 0 })), 0);
});

test('a fresh navigation ignores a position left over from earlier in the tab', () => {
  assert.equal(resolveNavIndex(entry({ restored: false, rememberedIndex: 3 })), 0);
});

test('a refresh with nothing remembered falls back to position 0', () => {
  assert.equal(resolveNavIndex(entry({ restored: true, rememberedIndex: null })), 0);
});

const store = (initial = {}) => {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    dump: () => ({ ...data }),
  };
};

test('a position written for this tab reads back', () => {
  const s = store();
  writeNavIndex(s, 2);
  assert.equal(s.dump()[NAV_INDEX_KEY], '2');
  assert.equal(readNavIndex(s), 2);
});

test('a tab with no recorded position reads as none', () => {
  assert.equal(readNavIndex(store()), null);
});

test('a malformed recorded position reads as none', () => {
  assert.equal(readNavIndex(store({ [NAV_INDEX_KEY]: 'nope' })), null);
  assert.equal(readNavIndex(store({ [NAV_INDEX_KEY]: '-4' })), null);
});

test('storage that throws is not fatal', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readNavIndex(throwing), null);
  assert.doesNotThrow(() => writeNavIndex(throwing, 1));
});

test('a load is restored only when the browser re-showed an entry', () => {
  assert.equal(isRestoredLoad('reload'), true);
  assert.equal(isRestoredLoad('back_forward'), true);
  assert.equal(isRestoredLoad('navigate'), false);
  assert.equal(isRestoredLoad(null), false);
});
