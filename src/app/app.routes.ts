import { inject } from '@angular/core';
import { Routes, UrlMatchResult, UrlMatcher, UrlSegment } from '@angular/router';
import { Api } from './api';

/**
 * `/course/<course>` and everything under it, with the folder/lesson tail kept
 * as one parameter. A `**` wildcard cannot sit behind a prefix, and this custom
 * matcher keeps every course URL on the same route, so the Course component is
 * reused as the student walks the folder tree instead of being rebuilt.
 */
const courseMatcher: UrlMatcher = (segments: UrlSegment[]): UrlMatchResult | null => {
  if (segments.length < 2 || segments[0].path !== 'course') return null;
  const tail = segments.slice(2).map((s) => s.path).join('/');
  return {
    consumed: segments,
    posParams: {
      course: segments[1],
      tail: new UrlSegment(tail, {}),
    },
  };
};

/** Only an admin may open /admin; anyone else falls through to the catch-all. */
const isAdmin = async (): Promise<boolean> => {
  const api = inject(Api);
  void api.init();
  await api.ready;
  return !!api.me()?.is_admin;
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./course').then((m) => m.Course) },
  { matcher: courseMatcher, loadComponent: () => import('./course').then((m) => m.Course) },
  { path: 'bookmarks', loadComponent: () => import('./bookmarks').then((m) => m.Bookmarks) },
  { path: 'admin', loadComponent: () => import('./admin').then((m) => m.Admin), canMatch: [isAdmin] },
  { path: '**', redirectTo: '' },
];
