import { Injectable, signal } from '@angular/core';

export interface Lesson { id: string; title: string; kind: 'video' | 'pdf'; done: boolean }
export interface Section { title: string | null; lessons: Lesson[] }
export interface CourseData { title: string; sections: Section[] }
export interface AdminUser { id: number; email: string; is_admin: number; watched: number; owner: boolean; google: number; courses: string[] }
export interface BulkResult { added: { email: string; password?: string }[]; skipped: { email: string; reason: string }[] }
export interface Me { id: number; email: string; is_admin: number }
export interface Comment {
  id: number; parent_id: number | null; body: string; created: number;
  name: string; initial: string; likes: number; liked: boolean; own: boolean; can_delete: boolean;
}
export interface ResourceItem { id: number; title: string; url: string; note: string | null }
export interface DirEntry { name: string; path: string }
export interface FileEntry { key: string; name: string; size: number; modified: number; lesson: boolean; hls: boolean }
export interface FileListing { path: string; dirs: DirEntry[]; files: FileEntry[] }
export interface UploadPart { partNumber: number; etag: string; size?: number }

/** A failed API call that still knows its HTTP status, which the uploader needs. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

@Injectable({ providedIn: 'root' })
export class Api {
  /** undefined = still checking the session, null = signed out */
  readonly me = signal<Me | null | undefined>(undefined);
  readonly courses = signal<CourseData[]>([]);

  private async req<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const res = await fetch('/api/' + path, body === undefined && !method ? {} : {
      method: method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'Request failed', res.status);
    return data as T;
  }

  async init(): Promise<void> {
    try {
      this.me.set(await this.req<Me>('me'));
      this.courses.set(await this.req<CourseData[]>('course'));
    } catch {
      this.me.set(null);
    }
  }

  async login(email: string, password: string): Promise<void> {
    await this.req('login', { email, password });
    await this.init();
  }

  /** Google OAuth client id from the server; '' when Google sign-in is not configured. */
  async googleClientId(): Promise<string> {
    try { return (await this.req<{ googleClientId: string }>('config')).googleClientId; } catch { return ''; }
  }

  async loginGoogle(credential: string): Promise<void> {
    await this.req('login/google', { credential });
    await this.init();
  }

  async logout(): Promise<void> {
    await this.req('logout', {});
    this.me.set(null);
    this.courses.set([]);
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

  getNotes(lesson: string): Promise<{ data: object[] }> { return this.req(`notes/${encodeURIComponent(lesson)}`); }
  saveNotes(lesson: string, data: object[]): Promise<unknown> { return this.req(`notes/${encodeURIComponent(lesson)}`, { data }, 'PUT'); }
  clearNotes(lesson: string): Promise<unknown> { return this.req(`notes/${encodeURIComponent(lesson)}`, undefined, 'DELETE'); }

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
  deleteResource(id: number): Promise<unknown> { return this.req(`admin/resources/${id}`, undefined, 'DELETE'); }

  mediaUrl(key: string): string {
    return '/api/media/' + key.split('/').map(encodeURIComponent).join('/');
  }

  // ---- Admin file manager ----
  listFiles(prefix = ''): Promise<FileListing> { return this.req(`admin/files?prefix=${encodeURIComponent(prefix)}`); }
  createFolder(path: string): Promise<unknown> { return this.req('admin/files/folder', { path }); }
  /** `warning` is set when the move finished but old files could not be removed yet. */
  moveEntry(from: string, to: string, kind: 'file' | 'folder'): Promise<{ ok: true; warning?: string }> {
    return this.req('admin/files/move', { from, to, kind });
  }
  deleteEntry(path: string, kind: 'file' | 'folder'): Promise<unknown> { return this.req('admin/files/delete', { path, kind }); }

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
