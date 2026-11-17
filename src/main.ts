import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { encodeBracketsInPath } from './app/course-route';

// Cloudflare's asset layer decodes `%28`/`%29` back to `(`/`)` before the app boots, and
// Angular reads a raw `(...)` as secondary-outlet syntax, which cuts a course/folder/lesson
// name at its first bracket on a reload or a shared link. Put the brackets back as `%28`/`%29`
// in the address before the router reads it, so the name survives whole.
const before = window.location.pathname;
const after = encodeBracketsInPath(before);
if (after !== before) {
  window.history.replaceState(
    window.history.state,
    '',
    after + window.location.search + window.location.hash,
  );
}

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
