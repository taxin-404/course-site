import { Injectable, signal } from '@angular/core';

export interface Lesson { id: string; title: string; kind: 'video' | 'pdf'; done: boolean }
export interface Section { title: string | null; lessons: Lesson[] }
export interface CourseData { title: string; sections: Section[] }
export interface Me { id: number; email: string; is_admin: number }

@Injectable({ providedIn: 'root' })
export class Api {
  /** undefined = still checking the session, null = signed out */
  readonly me = signal<Me | null | undefined>(undefined);
  readonly courses = signal<CourseData[]>([]);

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

  async logout(): Promise<void> {
    await this.req('logout', {});
    this.me.set(null);
    this.courses.set([]);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    await this.req('progress', { lesson: id, done });
    this.courses.update((courses) => courses.map((c) => ({
      ...c,
      sections: c.sections.map((s) => ({
        ...s,
        lessons: s.lessons.map((l) => (l.id === id ? { ...l, done } : l)),
      })),
    })));
  }

  addStudent(email: string, password: string): Promise<unknown> {
    return this.req('admin/users', { email, password });
  }

  mediaUrl(key: string): string {
    return '/api/media/' + key.split('/').map(encodeURIComponent).join('/');
  }
}
