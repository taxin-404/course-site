import { Injectable, signal } from '@angular/core';
import { fetchWithRetry } from './api-retry';

export interface Subtitle { key: string; lang: string }
export interface Lesson { id: string; title: string; kind: 'video' | 'pdf' | 'youtube'; done: boolean; subtitles?: Subtitle[] }
export interface Section { title: string | null; lessons: Lesson[] }
export interface CourseData { title: string; description: string; banner?: string; locked?: boolean; lessonCount?: number; sections: Section[] }
export interface AdminUser { id: number; email: string; is_admin: number; watched: number; owner: boolean; google: number; courses: string[] }
export interface YoutubeLesson { id: string; course: string; folder: string; lesson: string; yt: string }
export interface BulkResult { added: { email: string; password?: string }[]; skipped: { email: string; reason: string }[] }
export interface Me { id: number; email: string; is_admin: number; name?: string; ytKey?: string }
export interface Comment {
  id: number; parent_id: number | null; body: string; created: number;
  name: string; initial: string; likes: number; liked: boolean; own: boolean; can_delete: boolean;
}
export interface ResourceItem { id: number; title: string; url: string; note: string | null; kind: 'link' | 'pdf' }
export interface DirEntry { name: string; path: string; position?: number | null }
export interface FileEntry { key: string; name: string; size: number; modified: number; lesson: boolean; hls: boolean; position?: number | null }
export interface FileListing { path: string; dirs: DirEntry[]; files: FileEntry[]; order: Record<string, number> }
export interface UploadPart { partNumber: number; etag: string; size?: number }
export interface GoogleConfig { googleClientId: string; nonce?: string }

/** A failed API call that still knows its HTTP status, which the uploader needs. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * A JSON API call that gets no answer within this window is treated as failed, so a stalled
 * server can never leave a screen blank forever. The server already deadlines its own DB
 * queries well under this; the client timeout is the backstop for a network-level hang.
 */
const REQ_TIMEOUT_MS = 20000;

@Injectable({ providedIn: 'root' })
export class Api {
  /** undefined = still checking the session, null = signed out */
  readonly me = signal<Me | null | undefined>(undefined);
  readonly courses = signal<CourseData[]>([]);
  /** Admin-chosen positions by path, for the student browser's number labels. */
  readonly order = signal<Record<string, number>>({});

  /** Public config, fetched once. Kept so the login form does not wait on a second call. */
  private configReq?: Promise<GoogleConfig>;
  private googleCfg?: GoogleConfig;

  /** Drop the local session after the server rejects it (another device signed in). */
  private signOutLocal(): void {
    if (this.me() === null) return;
    this.me.set(null);
    this.courses.set([]);
    this.order.set({});
  }

  private async req<T>(path: string, body?: unknown, method?: string): Promise<T> {
    // Body-less, method-less calls are GETs. Everything else is a write, and writes are
    // never retried: the first attempt may have been applied before the answer was lost.
    const verb = body === undefined && !method ? 'GET' : (method ?? 'POST');
    const send = async (): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
      try {
        return await fetch('/api/' + path, {
          signal: ctrl.signal,
          ...(verb === 'GET' ? {} : {
            method: verb,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        });
      } catch (e) {
        // Our own deadline fired: report it like any other failed call so the caller can recover
        // (the sign-in screen still renders, because /api/config does no database work).
        if (e instanceof DOMException && e.name === 'AbortError') {
          throw new ApiError('The server is taking too long to respond. Please try again.', 0);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    // One retry for GETs on 503 or a transport/timeout failure; see api-retry.ts.
    const res = await fetchWithRetry(verb, send);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) this.signOutLocal();
    if (!res.ok) throw new ApiError(data.error || 'Request failed', res.status);
    return data as T;
  }

  private async raw<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch('/api/' + path, init);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) this.signOutLocal();
    if (!res.ok) throw new ApiError(data.error || 'Request failed', res.status);
    return data as T;
  }

  /**
   * Resolves after the first session check, so the admin route guard can wait for
   * `me` to be known instead of redirecting while it is still `undefined`.
   */
  private readyResolve?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });
  private initializing?: Promise<void>;

  init(): Promise<void> {
    // Bootstrap and the admin guard both call this; share the first run. A later
    // call (right after sign-in) starts a fresh check so the session is re-read.
    return (this.initializing ??= this.load().finally(() => {
      this.initializing = undefined;
      this.readyResolve?.();
    }));
  }

  private async load(): Promise<void> {
    // Ask for the public config alongside the session check, so the login form already
    // has the Google client id the moment it mounts and its button can render with the
    // email/password fields instead of a moment later.
    this.configReq ??= this.req<GoogleConfig>('config').catch(() => ({ googleClientId: '' }));
    try {
      this.me.set(await this.req<Me>('me'));
      this.courses.set(await this.req<CourseData[]>('course'));
      this.order.set(await this.req<Record<string, number>>('order'));
    } catch {
      this.me.set(null);
    }
  }

  /** Re-check the session; a 401 signs the client out through req(). */
  async refreshMe(): Promise<void> {
    if (this.me() == null) return;
    try { this.me.set(await this.req<Me>('me')); } catch { /* 401 already handled; a network error keeps the session */ }
  }

  async login(email: string, password: string): Promise<void> {
    await this.req('login', { email, password });
    await this.init();
  }

  /**
   * Google sign-in config from the server: the OAuth client id and the per-page sign-in
   * nonce the callback must echo. Empty client id means Google sign-in is not configured.
   */
  async googleConfig(): Promise<GoogleConfig> {
    if (!this.googleCfg) {
      this.configReq ??= this.req<GoogleConfig>('config').catch(() => ({ googleClientId: '' }));
      this.googleCfg = await this.configReq;
    }
    return this.googleCfg;
  }

  /**
   * Fetches the sign-in config again rather than reusing the cached copy, and returns it.
   * The nonce has to match the `gn` cookie the browser holds at the moment Google is
   * initialized: a form left open past the cookie's 12-hour life would otherwise present a
   * nonce the server no longer accepts and the Google callback fails with no way to
   * recover. The call is cheap — `/api/config` does no database work.
   */
  async freshGoogleConfig(): Promise<GoogleConfig> {
    this.configReq = this.req<GoogleConfig>('config').catch(() => ({ googleClientId: '' }));
    this.googleCfg = await this.configReq;
    return this.googleCfg;
  }

  /** Google OAuth client id from the server; '' when Google sign-in is not configured. */
  async googleClientId(): Promise<string> {
    return (await this.googleConfig()).googleClientId;
  }

  async loginGoogle(credential: string): Promise<void> {
    await this.req('login/google', { credential });
    await this.init();
  }

  async logout(): Promise<void> {
    await this.req('logout', {});
    this.me.set(null);
    this.courses.set([]);
    this.order.set({});
  }

  /** Signs out every device for this account by bumping the session version. */
  async logoutEverywhere(): Promise<void> {
    await this.req('logout/all', {});
    this.me.set(null);
    this.courses.set([]);
    this.order.set({});
  }

  async setDone(id: string, done: boolean): Promise<void> {
    const apply = (value: boolean) => this.courses.update((courses) => courses.map((c) => ({
      ...c,
      sections: c.sections.map((s) => ({
        ...s,
        lessons: s.lessons.map((l) => (l.id === id ? { ...l, done: value } : l)),
      })),
    })));
    apply(done); // optimistic: update the UI first
    try {
      await this.req('progress', { lesson: id, done });
    } catch (e) {
      apply(!done); // roll back if the server rejected it
      throw e;
    }
  }

  listUsers(): Promise<AdminUser[]> { return this.req<AdminUser[]>('admin/users'); }
  addUser(email: string, password: string, is_admin: boolean, google_only = false, courses: string[] = []): Promise<unknown> {
    return this.req('admin/users', { email, password, is_admin, google_only, courses });
  }
  adminCourses(): Promise<string[]> { return this.req<string[]>('admin/courses'); }
  setCourses(id: number, courses: string[]): Promise<unknown> { return this.req(`admin/users/${id}/courses`, { courses }); }
  bulkAdd(emails: string[], google_only: boolean, is_admin: boolean, courses: string[] = []): Promise<BulkResult> {
    return this.req<BulkResult>('admin/users/bulk', { emails, google_only, is_admin, courses });
  }
  resetPassword(id: number, password: string): Promise<unknown> { return this.req(`admin/users/${id}/password`, { password }); }
  setRole(id: number, is_admin: boolean): Promise<unknown> { return this.req(`admin/users/${id}/role`, { is_admin }); }
  deleteUser(id: number): Promise<unknown> { return this.req(`admin/users/${id}`, undefined, 'DELETE'); }

  listYoutubeLessons(): Promise<YoutubeLesson[]> { return this.req<YoutubeLesson[]>('admin/youtube'); }
  addYoutubeLesson(course: string, folder: string, lesson: string, link: string): Promise<{ ok: boolean; id: string; yt: string; shadowed: boolean }> {
    return this.req('admin/youtube', { course, folder, lesson, link });
  }
  renameYoutubeLesson(id: string, name: string): Promise<{ ok: boolean; id: string }> {
    return this.req('admin/youtube/rename', { id, name });
  }
  deleteYoutubeLesson(id: string): Promise<unknown> { return this.req('admin/youtube', { id }, 'DELETE'); }

  getNotes(lesson: string): Promise<{ data: object[] }> { return this.req(`notes/${encodeURIComponent(lesson)}`); }
  saveNotes(lesson: string, data: object[]): Promise<unknown> { return this.req(`notes/${encodeURIComponent(lesson)}`, { data }, 'PUT'); }
  clearNotes(lesson: string): Promise<unknown> { return this.req(`notes/${encodeURIComponent(lesson)}`, undefined, 'DELETE'); }

  /**
   * Stores one image pasted into a PDF's notes and returns its private same-origin URL.
   * The id is the browser-computed SHA-256 of the bytes, so storing the same image twice is
   * idempotent. Raw bytes, not JSON: a pasted image is far larger than the notes row allows.
   */
  uploadNoteAsset(lesson: string, id: string, bytes: Uint8Array, type: string): Promise<{ url: string }> {
    return this.raw(`note-asset/${encodeURIComponent(lesson)}/${id}`, {
      method: 'PUT',
      headers: { 'content-type': type },
      body: bytes as unknown as BodyInit,
    });
  }

  // ---- Lesson discussion, private notes, resources (video lessons) ----
  private lessonPath(key: string, tail: string): string {
    return `lesson/${encodeURIComponent(key)}/${tail}`;
  }

  comments(key: string): Promise<{ comments: Comment[] }> { return this.req(this.lessonPath(key, 'comments')); }
  postComment(key: string, body: string, parent?: number): Promise<{ comment: Comment }> {
    return this.req(this.lessonPath(key, 'comments'), parent ? { body, parent } : { body });
  }
  likeComment(id: number): Promise<{ liked: boolean; likes: number }> { return this.req(`comments/${id}/like`, {}); }
  deleteComment(id: number): Promise<unknown> { return this.req(`comments/${id}`, undefined, 'DELETE'); }

  videoNotes(key: string): Promise<{ body: string }> { return this.req(this.lessonPath(key, 'notes')); }
  saveVideoNotes(key: string, body: string): Promise<unknown> { return this.req(this.lessonPath(key, 'notes'), { body }, 'PUT'); }

  resources(key: string): Promise<{ resources: ResourceItem[] }> { return this.req(this.lessonPath(key, 'resources')); }
  addResource(key: string, r: { title: string; url: string; note?: string }): Promise<{ resource: ResourceItem }> {
    return this.req(`admin/${this.lessonPath(key, 'resources')}`, r);
  }
  uploadResourcePdf(key: string, file: File, title?: string, note?: string): Promise<{ resource: ResourceItem }> {
    const form = new FormData();
    form.append('file', file);
    if (title) form.append('title', title);
    if (note) form.append('note', note);
    return this.raw(`admin/${this.lessonPath(key, 'resources')}/pdf`, { method: 'POST', body: form });
  }
  deleteResource(id: number): Promise<unknown> { return this.req(`admin/resources/${id}`, undefined, 'DELETE'); }
  updateResource(id: number, r: { title: string; url?: string; note?: string }): Promise<{ resource: ResourceItem }> {
    return this.req(`admin/resources/${id}`, r, 'PATCH');
  }

  mediaUrl(key: string): string {
    return '/api/media/' + key.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * The YouTube id for one lesson, fetched when that lesson opens. The id is deliberately not
   * part of the bulk course list, so it cannot be scraped in one request.
   */
  getYt(id: string): Promise<{ yt: string }> {
    return this.req(`lesson/${encodeURIComponent(id)}/yt`);
  }

  // ---- Admin file manager ----
  listFiles(prefix = ''): Promise<FileListing> { return this.req(`admin/files?prefix=${encodeURIComponent(prefix)}`); }
  createFolder(path: string): Promise<unknown> { return this.req('admin/files/folder', { path }); }
  /** `warning` is set when the move finished but old files could not be removed yet. */
  moveEntry(from: string, to: string, kind: 'file' | 'folder'): Promise<{ ok: true; warning?: string }> {
    return this.req('admin/files/move', { from, to, kind });
  }
  deleteEntry(path: string, kind: 'file' | 'folder'): Promise<unknown> { return this.req('admin/files/delete', { path, kind }); }
  /**
   * Places one entry at `position` inside its folder; the server renumbers the folder
   * 1..N. `null` clears the number, which restores the default ordering for that entry.
   */
  setFilePosition(path: string, position: number | null): Promise<{ ok: true; path: string; position: number | null; order?: Record<string, number> }> {
    return this.req('admin/files/order', { path, position });
  }
  /** Sets or clears the description shown for a course (its top-level folder name). */
  saveCourseDescription(course: string, description: string): Promise<{ ok: true; course: string; description: string }> {
    return this.req('admin/files/description', { course, description });
  }
  /** Reads the stored description, so an editor can prefill a course that has no lessons yet. */
  courseDescription(course: string): Promise<{ course: string; description: string }> {
    return this.req(`admin/files/description?course=${encodeURIComponent(course)}`);
  }

  uploadStart(key: string, size: number, overwrite = false): Promise<{ uploadId: string; key: string }> {
    return this.req('admin/files/upload/start', { key, size, overwrite });
  }
  uploadPartUrl(key: string, uploadId: string, partNumber: number): Promise<{ url: string }> {
    return this.req('admin/files/upload/part', { key, uploadId, partNumber });
  }
  uploadUrl(key: string, size: number, overwrite = false): Promise<{ url: string }> {
    return this.req('admin/files/upload/url', { key, size, overwrite });
  }
  /** Small uploads finish in the browser, so this drops the Worker's course cache. */
  uploadDone(key: string): Promise<unknown> {
    return this.req('admin/files/upload/done', { key });
  }
  uploadComplete(key: string, uploadId: string, parts: UploadPart[]): Promise<unknown> {
    return this.req('admin/files/upload/complete', { key, uploadId, parts });
  }
  uploadAbort(key: string, uploadId: string): Promise<unknown> {
    return this.req('admin/files/upload/abort', { key, uploadId });
  }
  uploadParts(key: string, uploadId: string): Promise<{ parts: UploadPart[] }> {
    return this.req(`admin/files/upload/parts?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`);
  }
}
