import { Component, ElementRef, afterRenderEffect, inject, signal, viewChild } from '@angular/core';
import { Api } from './api';
import { Login } from './login';
import { Course } from './course';
import { Admin } from './admin';
import { LessonSearch } from './lesson-search';

@Component({
  selector: 'app-root',
  imports: [Login, Course, Admin],
  template: `
    @if (api.me(); as me) {
      <header [class.searching]="search.expanded()">
        <h2 class="logo">Course</h2>

        @if (!admin() && search.visible()) {
          <div class="head-search">
            <div class="head-field">
              <svg class="head-mag" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
              <input
                #lessonQ
                type="search"
                placeholder="Search lessons..."
                aria-label="Search lessons in this course"
                [value]="search.query()"
                (input)="search.query.set($any($event.target).value)"
                (keydown.escape)="closeSearch()"
              />
              @if (search.query()) {
                <button type="button" class="head-clear" aria-label="Clear search" (click)="search.query.set(''); lessonQ.focus()">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                </button>
              }
            </div>
            <button #searchToggle type="button" class="head-toggle" aria-label="Search lessons" [attr.aria-expanded]="search.expanded()" (click)="search.open()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
            </button>
            <button type="button" class="head-close" aria-label="Close search" (click)="closeSearch()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </div>
        }

        <div class="head-actions">
          @if (me.is_admin) {
            <button (click)="admin.set(!admin())">{{ admin() ? 'Back to course' : 'Admin panel' }}</button>
          }
          <button (click)="signOut()">Sign out</button>
        </div>
      </header>
      @if (admin() && me.is_admin) { <app-admin /> } @else { <app-course /> }
    } @else if (api.me() === null) {
      <app-login />
    }
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly search = inject(LessonSearch);
  protected readonly admin = signal(false);
  private readonly lessonInput = viewChild<ElementRef<HTMLInputElement>>('lessonQ');
  private readonly searchToggle = viewChild<ElementRef<HTMLButtonElement>>('searchToggle');
  private returnFocus = false;

  constructor() {
    void this.api.init();
    // On a phone the header swaps to the full-width field; move focus with it, and
    // hand focus back to the magnifier when the field collapses (after it is visible).
    afterRenderEffect(() => {
      if (this.search.expanded()) {
        this.lessonInput()?.nativeElement.focus();
        return;
      }
      if (this.returnFocus) {
        this.returnFocus = false;
        this.searchToggle()?.nativeElement.focus();
      }
    });
  }

  protected closeSearch(): void {
    if (this.search.expanded()) this.returnFocus = true;
    this.search.close();
  }

  protected async signOut(): Promise<void> {
    this.admin.set(false);
    this.search.reset();
    await this.api.logout();
  }
}