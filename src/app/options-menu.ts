import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api';
import { Shell } from './shell';
import { Theme } from './theme';

/**
 * The single options menu shared by the header, the lesson bar and the admin shell.
 * One `⋮` opens Admin panel / Back to course and Sign out everywhere (admins only),
 * the two-way theme switch, and Sign out.
 */
@Component({
  selector: 'app-options-menu',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { '(document:click)': 'onDocClick($event)' },
  template: `
    <button
      #btn
      type="button"
      class="icon-btn"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="open() ? 'Close options menu' : 'Open options menu'"
      (click)="toggle()"
      (keydown.escape)="close()"
    >
      <svg class="menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
    </button>

    @if (open()) {
      <div class="menu" role="menu" aria-label="Options">
        <button type="button" role="menuitem" (click)="openBookmarks()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
          Bookmarks
        </button>
        @if (isAdmin()) {
          <button type="button" role="menuitem" (click)="toggleAdmin()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /></svg>
            {{ shell.admin() ? 'Back to course' : 'Admin panel' }}
          </button>
        }
        <button type="button" role="menuitemcheckbox" [attr.aria-checked]="theme.dark()" (click)="theme.toggle()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>
          Dark mode
          <span class="switch" [class.on]="theme.dark()" aria-hidden="true"></span>
        </button>
        <!-- Admins can hold several live sessions, so ending them all is theirs to do.
             A student has one live session at a time (a new login displaces the old
             device), so "Sign out" is already the whole story for them. -->
        @if (isAdmin()) {
          <button type="button" role="menuitem" (click)="signOutEverywhere()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="10" rx="1.5" /><path d="M7 19h5" /><path d="M9 15v4" /><path d="m17 9 4 3-4 3" /><path d="M21 12h-6" /></svg>
            Sign out everywhere
          </button>
        }
        <button type="button" role="menuitem" (click)="signOut()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v16h-6" /><path d="m10 8-4 4 4 4" /><path d="M6 12h10" /></svg>
          Sign out
        </button>
      </div>
    }
  `,
})
export class OptionsMenu {
  protected readonly shell = inject(Shell);
  protected readonly theme = inject(Theme);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly btn = viewChild<ElementRef<HTMLButtonElement>>('btn');

  protected readonly open = signal(false);
  protected readonly isAdmin = computed(() => !!this.api.me()?.is_admin);

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.btn()?.nativeElement.focus();
  }

  protected openBookmarks(): void {
    this.open.set(false);
    void this.router.navigateByUrl('/bookmarks');
  }

  protected toggleAdmin(): void {
    this.open.set(false);
    this.shell.toggleAdmin();
  }

  protected async signOut(): Promise<void> {
    this.open.set(false);
    await this.shell.signOut();
  }

  /** Ends every session for the account; confirmed because it signs out other devices. */
  protected async signOutEverywhere(): Promise<void> {
    this.open.set(false);
    if (!confirm('Sign out of every device? You will need to sign in again on each one.')) return;
    await this.shell.signOutEverywhere();
  }

  protected onDocClick(e: MouseEvent): void {
    if (!this.open()) return;
    if (!(e.target as HTMLElement | null)?.closest('app-options-menu')) this.open.set(false);
  }
}
