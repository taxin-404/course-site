import { Injectable, signal } from '@angular/core';

export interface Lesson { id: string; title: string; kind: 'video' | 'pdf'; done: boolean }
export interface Section { title: string | null; lessons: Lesson[] }
export interface CourseData { title: string; sections: Section[] }
export interface AdminUser { id: number; email: string; is_admin: number; watched: number; owner: boolean; google: number; courses: string[] }
export interface BulkResult { added: { email: string; password?: string }[]; skipped: { email: string; reason: string }[] }
export interface Me { id: number; email: string; is_admin: number }

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
    if (!res.ok) throw new Error(data.error || 'Request failed');
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

  mediaUrl(key: string): string {
    return '/api/media/' + key.split('/').map(encodeURIComponent).join('/');
  }
}
