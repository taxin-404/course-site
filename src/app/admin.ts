import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { Api, AdminUser, BulkResult } from './api';

type SortKey = 'email' | 'progress' | 'courses';
type RoleFilter = 'all' | 'student' | 'admin';
interface Confirm { title: string; body: string; label: string; danger: boolean; run: () => void | Promise<void> }
interface Toast { id: number; text: string; bad: boolean }

const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
const ROLES: { key: RoleFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'student', label: 'Students' },
  { key: 'admin', label: 'Admins' },
];

@Component({
  selector: 'app-admin',
  template: `
    <main class="admin" (document:keydown.escape)="onEsc()">
      <!-- Header -->
      <div class="adm-top">
        <div>
          <h1>Admin</h1>
          <p class="adm-sub">
            {{ filtered().length }} of {{ users().length }} user{{ users().length === 1 ? '' : 's' }} shown
            · {{ admins() }} admin{{ admins() === 1 ? '' : 's' }}
          </p>
        </div>
        <div class="adm-top-actions">
          <button type="button" class="adm-ico" title="Refresh" aria-label="Refresh list" [disabled]="loading()" (click)="refresh()">
            <svg [class.spinning]="loading()" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button type="button" class="p" (click)="openAdd()">+ Add users</button>
        </div>
      </div>

      <!-- Overview -->
      <section class="adm-stats" aria-label="Overview">
        <div class="stat"><b>{{ users().length }}</b><span>Users</span></div>
        <div class="stat"><b>{{ students() }}</b><span>Students</span></div>
        <div class="stat"><b>{{ admins() }}</b><span>Admins</span></div>
        <div class="stat"><b>{{ googleCount() }}</b><span>Google linked</span></div>
        <div class="stat"><b>{{ watchedTotal() }}</b><span>Lessons watched</span></div>
        <div class="stat"><b>{{ courseList().length }}</b><span>Courses</span></div>
      </section>

      <!-- Default access for new users -->
      <section class="adm-card">
        <button type="button" class="adm-card-head" [attr.aria-expanded]="showDefaults()" (click)="showDefaults.set(!showDefaults())">
          <span class="adm-card-title">
            <strong>Default course access</strong>
            <small>{{ pick().length }} selected · pre-filled whenever you add users</small>
          </span>
          <span class="adm-caret" [class.open]="showDefaults()">▾</span>
        </button>
        @if (showDefaults()) {
          <div class="adm-card-body">
            <div class="adm-chips">
              @for (c of courseList(); track c) {
                <label class="chip" [class.on]="pick().includes(c)">
                  <input type="checkbox" [checked]="pick().includes(c)" (change)="togglePick(c)" />
                  <span>{{ c }}</span>
                </label>
              } @empty {
                <span class="adm-muted">No courses found in the bucket yet.</span>
              }
            </div>
          </div>
        }
      </section>

      <!-- Toolbar -->
      <div class="adm-toolbar">
        <label class="adm-search">
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="Search by email…" aria-label="Search users by email" [value]="search()" (input)="search.set($any($event.target).value)" />
        </label>
        <div class="seg" role="group" aria-label="Filter by role">
          @for (r of roles; track r.key) {
            <button type="button" [class.on]="role() === r.key" (click)="role.set(r.key)">{{ r.label }}</button>
          }
        </div>
        <select class="adm-sort" aria-label="Sort users" [value]="sort()" (change)="sort.set($any($event.target).value)">
          <option value="email">Email A–Z</option>
          <option value="progress">Most progress</option>
          <option value="courses">Most courses</option>
        </select>
      </div>

      <!-- Bulk actions -->
      @if (selected().size) {
        <div class="adm-bulk" role="toolbar" aria-label="Bulk actions">
          <strong>{{ selected().size }} selected</strong>
          <button type="button" [disabled]="busy()" (click)="bulkRole(true)">Make admin</button>
          <button type="button" [disabled]="busy()" (click)="bulkRole(false)">Remove admin</button>
          <button type="button" class="d" [disabled]="busy()" (click)="askBulkDelete()">Delete</button>
          <button type="button" class="link" (click)="clearSel()">Clear</button>
        </div>
      }

      <!-- User list -->
      <section class="adm-card adm-list">
        <div class="adm-lhead">
          <label class="adm-check">
            <input type="checkbox" aria-label="Select all users" [checked]="allSelected()" (change)="toggleAll($any($event.target).checked)" />
          </label>
          <span>User</span>
          <span class="adm-col-prog">Progress</span>
          <span class="adm-col-acc">Access</span>
          <span class="adm-col-act"></span>
        </div>

        @if (loading()) {
          @for (i of [1, 2, 3, 4, 5]; track i) {
            <div class="adm-skel" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
          }
        } @else if (!filtered().length) {
          <p class="adm-empty">No users match. Try a different search or filter.</p>
        } @else {
          @for (u of filtered(); track u.id) {
            <div class="adm-row" [class.sel]="selected().has(u.id)">
              <label class="adm-check" (click)="$event.stopPropagation()">
                <input type="checkbox" [attr.aria-label]="'Select ' + u.email" [checked]="selected().has(u.id)" (change)="toggleSel(u.id)" />
              </label>
              <div class="adm-user">
                <span class="av">{{ u.email.charAt(0).toUpperCase() }}</span>
                <span class="who">
                  <strong>{{ u.email }}</strong>
                  <small>
                    @if (u.owner) { Owner } @else if (u.is_admin) { Administrator } @else { Student }
                    @if (u.google) { · Google sign-in }
                  </small>
                </span>
              </div>
              <span class="adm-col-prog">{{ u.watched }} lesson{{ u.watched === 1 ? '' : 's' }}</span>
              <span class="adm-col-acc">
                @if (u.is_admin) { <span class="pill adm">All courses</span> }
                @else { <span class="pill">{{ u.courses.length }} course{{ u.courses.length === 1 ? '' : 's' }}</span> }
              </span>
              <span class="adm-col-act">
                <button type="button" (click)="open(u)">Manage</button>
              </span>
            </div>
          }
        }
      </section>
    </main>

    <!-- Detail drawer -->
    @if (active(); as u) {
      <div class="adm-scrim" (click)="closeDrawer()"></div>
      <aside class="adm-drawer" role="dialog" aria-modal="true" [attr.aria-label]="'Manage ' + u.email">
        <header class="adm-drawer-top">
          <span class="av big">{{ u.email.charAt(0).toUpperCase() }}</span>
          <div class="who">
            <strong>{{ u.email }}</strong>
            <small>{{ u.is_admin ? (u.owner ? 'Owner · full access' : 'Administrator') : 'Student' }}@if (u.google) { · Google sign-in }</small>
          </div>
          <button type="button" class="adm-close" aria-label="Close" (click)="closeDrawer()">✕</button>
        </header>

        <div class="adm-drawer-body">
          <div class="adm-kpis">
            <div><b>{{ u.watched }}</b><span>Lessons watched</span></div>
            <div><b>{{ u.is_admin ? courseList().length : u.courses.length }}</b><span>Courses open</span></div>
          </div>

          <section class="adm-sec">
            <div class="adm-sec-head">
              <h4>Course access</h4>
              @if (!u.is_admin) {
                <button type="button" class="p sm" [disabled]="saving() || !changed(u)" (click)="saveCourses(u)">{{ saving() ? 'Saving…' : 'Save' }}</button>
              }
            </div>
            @if (u.is_admin) {
              <p class="adm-muted">Administrators can open every course.</p>
            } @else {
              <div class="adm-chips">
                @for (c of courseList(); track c) {
                  <label class="chip" [class.on]="draft().includes(c)">
                    <input type="checkbox" [checked]="draft().includes(c)" (change)="toggleDraft(c)" />
                    <span>{{ c }}</span>
                  </label>
                } @empty {
                  <span class="adm-muted">No courses found in the bucket yet.</span>
                }
              </div>
            }
          </section>

          <section class="adm-sec">
            <h4>Actions</h4>
            @if (u.owner) {
              <p class="adm-muted sm">
                The Owner is managed by Cloudflare secrets, not in this panel: it always signs in with
                Google, and <code>ADMIN_PASSWORD</code> (optional) is its password. It cannot be renamed,
                demoted or deleted here.
              </p>
            } @else {
              <div class="adm-stack">
                <button type="button" (click)="openReset(u)">Reset password</button>
                @if (u.id !== api.me()?.id) {
                  <button type="button" (click)="toggleRole(u)">{{ u.is_admin ? 'Remove admin' : 'Make admin' }}</button>
                  <button type="button" class="d" (click)="askDelete(u)">Delete user</button>
                }
              </div>
              <p class="adm-muted sm">Resetting a password or changing a role signs the user out everywhere.</p>
            }
          </section>
        </div>
      </aside>
    }

    <!-- Add users dialog -->
    @if (addOpen()) {
      <div class="adm-scrim" (click)="closeAdd()"></div>
      <div class="adm-dialog wide" role="dialog" aria-modal="true" aria-label="Add users">
        <header class="adm-dialog-top">
          <h3>Add users</h3>
          <button type="button" class="adm-close" aria-label="Close" (click)="closeAdd()">✕</button>
        </header>

        <div class="tabs">
          <button type="button" [class.on]="addTab() === 'single'" (click)="addTab.set('single')">Single</button>
          <button type="button" [class.on]="addTab() === 'bulk'" (click)="addTab.set('bulk')">Bulk</button>
        </div>

        @if (addTab() === 'single') {
          <div class="adm-form">
            <label class="field">
              <span>Email</span>
              <input type="email" autocomplete="off" placeholder="student@example.com" [value]="newEmail" (input)="newEmail = $any($event.target).value" />
            </label>

            @if (!newGoogle) {
              <label class="field">
                <span>Temporary password</span>
                <span class="pw">
                  <input [type]="showPw() ? 'text' : 'password'" autocomplete="new-password" placeholder="8+ characters" [value]="newPassword" (input)="newPassword = $any($event.target).value" />
                  <button type="button" (click)="showPw.set(!showPw())">{{ showPw() ? 'Hide' : 'Show' }}</button>
                  <button type="button" (click)="generate('new')">Generate</button>
                </span>
              </label>
            } @else {
              <p class="adm-muted sm">This user signs in with Google only.</p>
            }

            <div class="toggles">
              <label class="chip" [class.on]="newGoogle"><input type="checkbox" [checked]="newGoogle" (change)="newGoogle = $any($event.target).checked" /><span>Google sign-in only</span></label>
              <label class="chip" [class.on]="newAdmin"><input type="checkbox" [checked]="newAdmin" (change)="newAdmin = $any($event.target).checked" /><span>Administrator</span></label>
            </div>

            <div class="field">
              <span>Course access</span>
              <div class="adm-chips">
                @for (c of courseList(); track c) {
                  <label class="chip" [class.on]="newCourses().includes(c)"><input type="checkbox" [checked]="newCourses().includes(c)" (change)="toggleNewCourse(c)" /><span>{{ c }}</span></label>
                } @empty {
                  <span class="adm-muted">No courses found.</span>
                }
              </div>
            </div>
          </div>
          <footer class="adm-dialog-foot">
            <button type="button" (click)="closeAdd()">Cancel</button>
            <button type="button" class="p" [disabled]="busy()" (click)="add()">{{ busy() ? 'Adding…' : 'Add user' }}</button>
          </footer>
        } @else {
          <div class="adm-form">
            <label class="field">
              <span>Emails · one per line, or separated by commas or spaces</span>
              <textarea rows="6" placeholder="alice@gmail.com&#10;bob@gmail.com" [value]="bulkText()" (input)="bulkText.set($any($event.target).value)"></textarea>
            </label>

            <div class="toggles">
              <label class="chip file"><input type="file" accept=".csv,.txt,text/plain,text/csv" (change)="loadFile($event)" /><span>Load .csv / .txt</span></label>
              <label class="chip" [class.on]="bulkGoogle"><input type="checkbox" [checked]="bulkGoogle" (change)="bulkGoogle = $any($event.target).checked" /><span>Google sign-in only</span></label>
              <label class="chip" [class.on]="bulkAdmin"><input type="checkbox" [checked]="bulkAdmin" (change)="bulkAdmin = $any($event.target).checked" /><span>Administrators</span></label>
            </div>

            <div class="field">
              <span>Course access @if (bulkCount()) { <em>· {{ bulkCount() }} valid email{{ bulkCount() === 1 ? '' : 's' }} found</em> }</span>
              <div class="adm-chips">
                @for (c of courseList(); track c) {
                  <label class="chip" [class.on]="bulkCourses().includes(c)"><input type="checkbox" [checked]="bulkCourses().includes(c)" (change)="toggleBulkCourse(c)" /><span>{{ c }}</span></label>
                } @empty {
                  <span class="adm-muted">No courses found.</span>
                }
              </div>
            </div>

            @if (bulkBusy() && bulkTotal()) {
              <div class="bar"><i [style.width.%]="bulkDone() / bulkTotal() * 100"></i></div>
              <p class="adm-muted sm">Adding {{ bulkDone() }} of {{ bulkTotal() }}…</p>
            }

            @if (bulkResult(); as r) {
              <div class="adm-result">
                <p>Added <b>{{ r.added.length }}</b>@if (r.skipped.length) {, skipped <b>{{ r.skipped.length }}</b> ({{ skippedText(r) }})}.</p>
                @if (hasPasswords(r)) {
                  <p class="adm-muted sm">Temporary passwords are shown only now. Copy or download them and share each one privately.</p>
                  <textarea readonly rows="5">{{ csv(r) }}</textarea>
                  <div class="toggles">
                    <button type="button" (click)="copy(r)">Copy</button>
                    <button type="button" (click)="download(r)">Download CSV</button>
                  </div>
                }
              </div>
            }
          </div>
          <footer class="adm-dialog-foot">
            <button type="button" (click)="closeAdd()">Close</button>
            <button type="button" class="p" [disabled]="bulkBusy() || !bulkCount()" (click)="addMany()">
              {{ bulkBusy() ? 'Adding…' : 'Add ' + bulkCount() + ' user' + (bulkCount() === 1 ? '' : 's') }}
            </button>
          </footer>
        }
      </div>
    }

    <!-- Reset password dialog -->
    @if (pwFor(); as u) {
      <div class="adm-scrim" (click)="closeReset()"></div>
      <div class="adm-dialog" role="dialog" aria-modal="true" aria-label="Reset password">
        <header class="adm-dialog-top">
          <h3>Reset password</h3>
          <button type="button" class="adm-close" aria-label="Close" (click)="closeReset()">✕</button>
        </header>
        <div class="adm-form">
          <p class="adm-muted sm">New password for <b>{{ u.email }}</b>. They will be signed out everywhere.</p>
          <label class="field">
            <span>New password</span>
            <span class="pw">
              <input [type]="showPw() ? 'text' : 'password'" autocomplete="new-password" placeholder="8+ characters" [value]="pwValue" (input)="pwValue = $any($event.target).value" />
              <button type="button" (click)="showPw.set(!showPw())">{{ showPw() ? 'Hide' : 'Show' }}</button>
              <button type="button" (click)="generate('reset')">Generate</button>
            </span>
          </label>
        </div>
        <footer class="adm-dialog-foot">
          <button type="button" (click)="closeReset()">Cancel</button>
          <button type="button" class="p" [disabled]="busy() || pwValue.length < 8" (click)="doReset()">{{ busy() ? 'Updating…' : 'Update password' }}</button>
        </footer>
      </div>
    }

    <!-- Confirm dialog -->
    @if (confirm(); as c) {
      <div class="adm-scrim" (click)="closeConfirm()"></div>
      <div class="adm-dialog" role="alertdialog" aria-modal="true" [attr.aria-label]="c.title">
        <header class="adm-dialog-top"><h3>{{ c.title }}</h3></header>
        <p class="adm-dialog-body">{{ c.body }}</p>
        <footer class="adm-dialog-foot">
          <button type="button" (click)="closeConfirm()">Cancel</button>
          <button type="button" class="p" [class.d]="c.danger" [disabled]="busy()" (click)="runConfirm()">{{ c.label }}</button>
        </footer>
      </div>
    }

    <!-- Toasts -->
    <div class="toasts" aria-live="polite">
      @for (t of toasts(); track t.id) {
        <div class="toast" [class.bad]="t.bad" role="status" (click)="dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
})
export class Admin implements OnInit {
  protected readonly api = inject(Api);

  protected readonly users = signal<AdminUser[]>([]);
  protected readonly loading = signal(true);
  protected readonly courseList = signal<string[]>([]);

  protected readonly search = signal('');
  protected readonly role = signal<RoleFilter>('all');
  protected readonly sort = signal<SortKey>('email');
  protected readonly showDefaults = signal(true);
  protected readonly pick = signal<string[]>([]);

  protected readonly selected = signal<Set<number>>(new Set());

  protected readonly activeId = signal<number | null>(null);
  protected readonly draft = signal<string[]>([]);
  protected readonly saving = signal(false);

  protected readonly addOpen = signal(false);
  protected readonly addTab = signal<'single' | 'bulk'>('single');
  protected readonly newCourses = signal<string[]>([]);
  protected readonly bulkCourses = signal<string[]>([]);
  protected readonly bulkText = signal('');
  protected readonly bulkResult = signal<BulkResult | null>(null);
  protected readonly bulkBusy = signal(false);
  protected readonly bulkDone = signal(0);
  protected readonly bulkTotal = signal(0);
  protected readonly showPw = signal(false);
  protected readonly busy = signal(false);

  protected newEmail = '';
  protected newPassword = '';
  protected newGoogle = false;
  protected newAdmin = false;
  protected bulkGoogle = true;
  protected bulkAdmin = false;

  protected readonly pwFor = signal<AdminUser | null>(null);
  protected pwValue = '';
  protected readonly confirm = signal<Confirm | null>(null);
  protected readonly toasts = signal<Toast[]>([]);

  protected readonly roles = ROLES;

  protected readonly admins = computed(() => this.users().filter((u) => u.is_admin).length);
  protected readonly students = computed(() => this.users().filter((u) => !u.is_admin).length);
  protected readonly googleCount = computed(() => this.users().filter((u) => u.google).length);
  protected readonly watchedTotal = computed(() => this.users().reduce((n, u) => n + u.watched, 0));

  /** Users after the search text, role filter and sort. The owner is always pinned to the top. */
  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const role = this.role();
    const list = this.users().filter(
      (u) => (!q || u.email.toLowerCase().includes(q)) && (role === 'all' || (role === 'admin' ? !!u.is_admin : !u.is_admin)),
    );
    const cmp: Record<SortKey, (a: AdminUser, b: AdminUser) => number> = {
      email: (a, b) => a.email.localeCompare(b.email),
      progress: (a, b) => b.watched - a.watched || a.email.localeCompare(b.email),
      courses: (a, b) => b.courses.length - a.courses.length || a.email.localeCompare(b.email),
    };
    return [...list].sort((a, b) => Number(b.owner) - Number(a.owner) || cmp[this.sort()](a, b));
  });

  protected readonly allSelected = computed(
    () => this.filtered().length > 0 && this.filtered().every((u) => this.selected().has(u.id)),
  );

  /** Live row for the open drawer, so it never goes stale after a reload. */
  protected readonly active = computed(() => this.users().find((u) => u.id === this.activeId()) ?? null);

  protected readonly bulkCount = computed(() => this.parse(this.bulkText()).length);

  ngOnInit(): void {
    this.refresh();
  }

  // ---- data --------------------------------------------------------------
  protected refresh(): void {
    void this.load();
    this.api
      .adminCourses()
      .then((c) => this.courseList.set(c))
      .catch(() => this.toast('Could not load the course list.', true));
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.users.set(await this.api.listUsers());
    } catch (e) {
      this.toast((e as Error).message, true);
    } finally {
      this.loading.set(false);
    }
  }

  private seq = 0;
  protected toast(text: string, bad = false): void {
    const id = ++this.seq;
    this.toasts.update((list) => [...list, { id, text, bad }]);
    setTimeout(() => this.dismiss(id), 4200);
  }
  protected dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  // ---- selection ---------------------------------------------------------
  protected toggleSel(id: number): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  protected toggleAll(on: boolean): void {
    this.selected.set(on ? new Set(this.filtered().map((u) => u.id)) : new Set());
  }
  protected clearSel(): void {
    this.selected.set(new Set());
  }

  // ---- default access / drawer ------------------------------------------
  protected togglePick(c: string): void {
    this.pick.update((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  }

  protected open(u: AdminUser): void {
    this.activeId.set(u.id);
    this.draft.set([...u.courses]);
  }
  protected closeDrawer(): void {
    this.activeId.set(null);
  }
  protected toggleDraft(c: string): void {
    this.draft.update((d) => (d.includes(c) ? d.filter((x) => x !== c) : [...d, c]));
  }
  /** True when the draft differs from what the server currently has. */
  protected changed(u: AdminUser): boolean {
    const d = this.draft();
    return d.length !== u.courses.length || d.some((c) => !u.courses.includes(c));
  }

  protected async saveCourses(u: AdminUser): Promise<void> {
    this.saving.set(true);
    try {
      await this.api.setCourses(u.id, this.draft());
      await this.load();
      this.toast('Course access updated for ' + u.email + '.');
    } catch (e) {
      this.toast((e as Error).message, true);
    } finally {
      this.saving.set(false);
    }
  }

  protected async toggleRole(u: AdminUser): Promise<void> {
    try {
      await this.api.setRole(u.id, !u.is_admin);
      await this.load();
      this.toast(u.email + (u.is_admin ? ' is no longer an admin.' : ' is now an admin.'));
    } catch (e) {
      this.toast((e as Error).message, true);
    }
  }

  protected askDelete(u: AdminUser): void {
    this.confirm.set({
      title: 'Delete user?',
      body: `${u.email}'s progress and notes are removed too. This cannot be undone.`,
      label: 'Delete',
      danger: true,
      run: async () => {
        try {
          await this.api.deleteUser(u.id);
          this.closeDrawer();
          await this.load();
          this.toast('User deleted.');
        } catch (e) {
          this.toast((e as Error).message, true);
        }
      },
    });
  }

  // ---- bulk actions ------------------------------------------------------
  private bulkTargets(admin: boolean): AdminUser[] {
    const me = this.api.me()?.id;
    return this.users().filter(
      (u) => this.selected().has(u.id) && !u.owner && u.id !== me && !!u.is_admin !== admin,
    );
  }

  protected async bulkRole(admin: boolean): Promise<void> {
    const targets = this.bulkTargets(admin);
    if (!targets.length) {
      this.toast('Nothing to change for the selected users.');
      return;
    }
    this.busy.set(true);
    let ok = 0;
    for (const u of targets) {
      try {
        await this.api.setRole(u.id, admin);
        ok++;
      } catch {
        /* keep going, report the count */
      }
    }
    this.busy.set(false);
    this.clearSel();
    await this.load();
    this.toast(ok + ' user' + (ok === 1 ? '' : 's') + (admin ? ' made admin.' : ' no longer admin.'));
  }

  protected askBulkDelete(): void {
    const ids = [...this.selected()].filter((id) => {
      const u = this.users().find((x) => x.id === id);
      return u && !u.owner && u.id !== this.api.me()?.id;
    });
    if (!ids.length) {
      this.toast('The owner and your own account cannot be deleted.');
      return;
    }
    this.confirm.set({
      title: `Delete ${ids.length} user${ids.length === 1 ? '' : 's'}?`,
      body: 'Their progress and notes are removed too. This cannot be undone.',
      label: 'Delete',
      danger: true,
      run: async () => {
        this.busy.set(true);
        let ok = 0;
        for (const id of ids) {
          try {
            await this.api.deleteUser(id);
            ok++;
          } catch {
            /* keep going */
          }
        }
        this.busy.set(false);
        this.clearSel();
        await this.load();
        this.toast(ok + ' user' + (ok === 1 ? '' : 's') + ' deleted.');
      },
    });
  }

  // ---- confirm -----------------------------------------------------------
  protected async runConfirm(): Promise<void> {
    const c = this.confirm();
    if (!c) return;
    this.confirm.set(null);
    await c.run();
  }
  protected closeConfirm(): void {
    this.confirm.set(null);
  }

  // ---- reset password ----------------------------------------------------
  protected openReset(u: AdminUser): void {
    this.pwValue = '';
    this.pwFor.set(u);
  }
  protected closeReset(): void {
    this.pwFor.set(null);
    this.pwValue = '';
  }
  protected async doReset(): Promise<void> {
    const u = this.pwFor();
    if (!u || this.pwValue.length < 8) return;
    this.busy.set(true);
    try {
      await this.api.resetPassword(u.id, this.pwValue);
      this.toast('Password updated for ' + u.email + '.');
      this.closeReset();
    } catch (e) {
      this.toast((e as Error).message, true);
    } finally {
      this.busy.set(false);
    }
  }

  // ---- add users ---------------------------------------------------------
  protected openAdd(): void {
    this.newEmail = '';
    this.newPassword = '';
    this.newGoogle = false;
    this.newAdmin = false;
    this.newCourses.set([...this.pick()]);
    this.bulkCourses.set([...this.pick()]);
    this.bulkText.set('');
    this.bulkResult.set(null);
    this.bulkDone.set(0);
    this.bulkTotal.set(0);
    this.addTab.set('single');
    this.addOpen.set(true);
  }
  protected closeAdd(): void {
    this.addOpen.set(false);
  }
  protected toggleNewCourse(c: string): void {
    this.newCourses.update((d) => (d.includes(c) ? d.filter((x) => x !== c) : [...d, c]));
  }
  protected toggleBulkCourse(c: string): void {
    this.bulkCourses.update((d) => (d.includes(c) ? d.filter((x) => x !== c) : [...d, c]));
  }

  protected generate(kind: 'new' | 'reset' = 'new'): void {
    const buf = new Uint32Array(16);
    crypto.getRandomValues(buf);
    const pw = Array.from(buf, (n) => PW_CHARS[n % PW_CHARS.length]).join('');
    if (kind === 'reset') this.pwValue = pw;
    else this.newPassword = pw;
  }

  protected async add(): Promise<void> {
    const email = this.newEmail.trim();
    if (!email) {
      this.toast('Enter an email address.', true);
      return;
    }
    if (!this.newGoogle && this.newPassword.length < 8) {
      this.toast('Password must be at least 8 characters.', true);
      return;
    }
    this.busy.set(true);
    try {
      await this.api.addUser(email, this.newGoogle ? '' : this.newPassword, this.newAdmin, this.newGoogle, this.newCourses());
      await this.load();
      this.toast('User added: ' + email);
      this.newEmail = '';
      this.newPassword = '';
      this.newAdmin = false;
      this.newGoogle = false;
    } catch (e) {
      this.toast((e as Error).message, true);
    } finally {
      this.busy.set(false);
    }
  }

  protected parse(text: string): string[] {
    const out = new Set<string>();
    for (const t of text.split(/[\s,;]+/)) {
      const e = t.trim().replace(/^["'<]+|["'>]+$/g, '').toLowerCase();
      if (e.includes('@')) out.add(e);
    }
    return [...out];
  }

  protected async loadFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    this.bulkText.update((t) => (t ? t + '\n' : '') + text);
    input.value = '';
  }

  protected async addMany(): Promise<void> {
    const emails = this.parse(this.bulkText());
    if (!emails.length) return;
    const size = this.bulkGoogle ? 200 : 20; // password hashing is slow, so send small batches
    const total: BulkResult = { added: [], skipped: [] };
    this.bulkBusy.set(true);
    this.bulkTotal.set(emails.length);
    this.bulkDone.set(0);
    this.bulkResult.set(null);
    try {
      for (let i = 0; i < emails.length; i += size) {
        const r = await this.api.bulkAdd(emails.slice(i, i + size), this.bulkGoogle, this.bulkAdmin, this.bulkCourses());
        total.added.push(...r.added);
        total.skipped.push(...r.skipped);
        this.bulkDone.set(Math.min(i + size, emails.length));
        this.bulkResult.set({ added: [...total.added], skipped: [...total.skipped] });
      }
      this.bulkText.set('');
      this.bulkDone.set(0);
      this.bulkTotal.set(0);
      this.toast('Added ' + total.added.length + ' user' + (total.added.length === 1 ? '' : 's') + '.');
    } catch (e) {
      this.toast(
        (e as Error).message + (total.added.length ? ` (${total.added.length} were added before the error)` : ''),
        true,
      );
    } finally {
      this.bulkBusy.set(false);
      await this.load();
    }
  }

  protected hasPasswords(r: BulkResult): boolean {
    return r.added.some((a) => a.password);
  }
  protected skippedText(r: BulkResult): string {
    const n = (why: string) => r.skipped.filter((s) => s.reason === why).length;
    return [
      n('already exists') && n('already exists') + ' already exist',
      n('invalid email') && n('invalid email') + ' invalid',
    ]
      .filter(Boolean)
      .join(', ');
  }
  private esc(v: string): string {
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  protected csv(r: BulkResult): string {
    return (
      'email,password\n' +
      r.added
        .filter((a) => a.password)
        .map((a) => this.esc(a.email) + ',' + this.esc(a.password ?? ''))
        .join('\n')
    );
  }
  protected copy(r: BulkResult): void {
    void navigator.clipboard?.writeText(this.csv(r));
    this.toast('Copied to clipboard.');
  }
  protected download(r: BulkResult): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.csv(r)], { type: 'text/csv' }));
    a.download = 'new-users.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- misc --------------------------------------------------------------
  protected onEsc(): void {
    if (this.confirm()) this.closeConfirm();
    else if (this.pwFor()) this.closeReset();
    else if (this.addOpen()) this.closeAdd();
    else if (this.activeId() !== null) this.closeDrawer();
  }
}
