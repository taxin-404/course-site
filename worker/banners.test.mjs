import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerExt, bannerKeys, BANNER_TYPES } from './banners.js';

test('accepts the four image extensions, case-insensitively', () => {
  assert.equal(bannerExt('Algebra/banner.jpg'), 'jpg');
  assert.equal(bannerExt('Algebra/banner.JPEG'), 'jpeg');
  assert.equal(bannerExt('Algebra/banner.png'), 'png');
  assert.equal(bannerExt('Algebra/banner.WebP'), 'webp');
  assert.equal(bannerExt('Algebra/Banner.PNG'), 'png');
});

test('only a course-root file named banner', () => {
  assert.equal(bannerExt('Algebra/Section/banner.jpg'), null);
  assert.equal(bannerExt('banner.jpg'), null);
  assert.equal(bannerExt('Algebra/banner.gif'), null);
  assert.equal(bannerExt('Algebra/banner.jpg.txt'), null);
  assert.equal(bannerExt('Algebra/my-banner.jpg'), null);
});

test('one winning key per course, jpg first', () => {
  const map = bannerKeys([
    'Algebra/banner.png',
    'Algebra/banner.jpg',
    'Geometry/banner.webp',
    'Geometry/lesson.mp4',
    'Algebra/Section/banner.png',
  ]);
  assert.equal(map.get('Algebra'), 'Algebra/banner.jpg');
  assert.equal(map.get('Geometry'), 'Geometry/banner.webp');
  assert.equal(map.size, 2);
});

test('exposes content types for the serving route', () => {
  assert.deepEqual(BANNER_TYPES, {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  });
});
