// Course banners are a named file at the course root; this module is the one
// place that decides what counts as one and which file wins when several exist.

const BANNER_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'svg'];

export const BANNER_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** The extension of a course banner key, or null. Only <course>/banner.<ext>. */
export function bannerExt(key) {
  if (typeof key !== 'string') return null;
  const m = /^[^/]+\/banner\.([a-z]+)$/i.exec(key);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return Object.hasOwn(BANNER_TYPES, ext) ? ext : null;
}

/** Picks one banner key per course; extensions earlier in BANNER_EXTS win. */
export function bannerKeys(keys) {
  const rank = new Map(BANNER_EXTS.map((ext, i) => [ext, i]));
  const out = new Map();
  for (const key of keys || []) {
    const ext = bannerExt(key);
    if (!ext) continue;
    const course = key.slice(0, key.indexOf('/'));
    const prev = out.get(course);
    if (!prev || rank.get(ext) < rank.get(bannerExt(prev))) out.set(course, key);
  }
  return out;
}
