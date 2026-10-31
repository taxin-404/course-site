import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Api, Comment, Lesson } from './api';

/**
 * Discussion under a video lesson: top-level comments newest first, one level of
 * replies under each, likes and delete. The list is fetched per lesson key.
 */
@Component({
  selector: 'app-discussion',
  template: `
    <div class="dc">
      <form class="dc-compose" (submit)="$event.preventDefault(); post()">
        <span class="dc-avatar" aria-hidden="true">{{ myInitial() }}</span>
        <div class="dc-compose-body">
          <textarea
            rows="2"
            maxlength="1000"
            placeholder="Ask a question or leave a comment…"
            aria-label="Write a comment"
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
            (keydown.control.enter)="post(); $event.preventDefault()"
            (keydown.meta.enter)="post(); $event.preventDefault()"
          ></textarea>
          <div class="dc-compose-foot">
            @if (draft().length > 900) { <span class="dc-count">{{ draft().length }}/1000</span> }
            <button class="p" type="submit" [disabled]="!draft().trim() || posting()">
              {{ posting() ? 'Posting…' : 'Post' }}
            </button>
          </div>
        </div>
      </form>

      @if (error()) { <p class="dc-error" role="alert">{{ error() }}</p> }

      @if (state() === 'loading') {
        <p class="dc-muted">Loading comments…</p>
      } @else if (state() === 'error') {
        <p class="dc-muted">Could not load comments. <button type="button" class="dc-link" (click)="reload()">Retry</button></p>
      } @else if (!rows().length) {
        <p class="dc-muted">No comments yet. Start the discussion.</p>
      } @else {
        @for (c of top(); track c.id) {
          <article class="dc-item">
            <span class="dc-avatar sm" aria-hidden="true">{{ c.initial }}</span>
            <div class="dc-main">
              <p class="dc-head"><b>{{ c.name }}</b><span class="dc-time">{{ ago(c.created) }}</span></p>
              <p class="dc-body">{{ c.body }}</p>
              <div class="dc-actions">
                <button type="button" class="dc-act" [class.liked]="c.liked" [attr.aria-pressed]="c.liked" aria-label="Like comment" (click)="like(c)">
                  <span aria-hidden="true">{{ c.liked ? '♥' : '♡' }}</span> @if (c.likes) { <span>{{ c.likes }}</span> }
                </button>
                <button type="button" class="dc-act" (click)="toggleReply(c.id)">Reply</button>
                @if (c.can_delete) {
                  <button type="button" class="dc-act del" aria-label="Delete comment" title="Delete comment" (click)="remove(c)">×</button>
                }
              </div>

              @if (replies(c.id).length) {
                <button type="button" class="dc-link" (click)="toggleExpand(c.id)">
                  {{ isExpanded(c.id) ? 'Hide replies' : 'Show ' + replies(c.id).length + ' ' + (replies(c.id).length === 1 ? 'reply' : 'replies') }}
                </button>
              }

              @if (isExpanded(c.id)) {
                @for (r of replies(c.id); track r.id) {
                  <article class="dc-item reply">
                    <span class="dc-avatar xs" aria-hidden="true">{{ r.initial }}</span>
                    <div class="dc-main">
                      <p class="dc-head"><b>{{ r.name }}</b><span class="dc-time">{{ ago(r.created) }}</span></p>
                      <p class="dc-body">{{ r.body }}</p>
                      <div class="dc-actions">
                        <button type="button" class="dc-act" [class.liked]="r.liked" [attr.aria-pressed]="r.liked" aria-label="Like reply" (click)="like(r)">
                          <span aria-hidden="true">{{ r.liked ? '♥' : '♡' }}</span> @if (r.likes) { <span>{{ r.likes }}</span> }
                        </button>
                        @if (r.can_delete) {
                          <button type="button" class="dc-act del" aria-label="Delete reply" title="Delete reply" (click)="remove(r)">×</button>
                        }
                      </div>
                    </div>
                  </article>
                }
              }

              @if (replyTo() === c.id) {
                <form class="dc-compose inline" (submit)="$event.preventDefault(); post(c.id)">
                  <span class="dc-avatar xs" aria-hidden="true">{{ myInitial() }}</span>
                  <div class="dc-compose-body">
                    <textarea
                      rows="2"
                      maxlength="1000"
                      placeholder="Reply to {{ c.name }}…"
                      aria-label="Write a reply"
                      [value]="replyDraft()"
                      (input)="replyDraft.set($any($event.target).value)"
                      (keydown.control.enter)="post(c.id); $event.preventDefault()"
                      (keydown.meta.enter)="post(c.id); $event.preventDefault()"
                    ></textarea>
                    <div class="dc-compose-foot">
                      <button type="button" class="dc-act" (click)="toggleReply(c.id)">Cancel</button>
                      <button class="p" type="submit" [disabled]="!replyDraft().trim() || posting()">{{ posting() ? 'Posting…' : 'Reply' }}</button>
                    </div>
                  </div>
                </form>
              }
            </div>
          </article>
        }
      }
    </div>
  `,
})
export class Discussion {
  private readonly api = inject(Api);
  readonly lesson = input.required<Lesson>();
  readonly count = output<number>();

  protected readonly rows = signal<Comment[]>([]);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly draft = signal('');
  protected readonly replyDraft = signal('');
  protected readonly posting = signal(false);
  protected readonly error = signal('');
  protected readonly replyTo = signal<number | null>(null);
  private readonly expanded = signal<ReadonlySet<number>>(new Set());

  protected readonly top = computed(() => this.rows().filter((c) => c.parent_id == null));
  private readonly byParent = computed(() => {
    const map = new Map<number, Comment[]>();
    for (const c of this.rows()) {
      if (c.parent_id != null) map.set(c.parent_id, [...(map.get(c.parent_id) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.created - b.created);
    return map;
  });
  protected readonly myInitial = computed(() => (this.api.me()?.email?.[0] ?? '?').toUpperCase());

  constructor() {
    effect(() => {
      const key = this.lesson().id;
      untracked(() => {
        this.replyTo.set(null);
        this.draft.set('');
        this.replyDraft.set('');
        this.error.set('');
        this.expanded.set(new Set());
        void this.load(key);
      });
    });
  }

  protected replies(id: number): Comment[] { return this.byParent().get(id) ?? []; }
  protected isExpanded(id: number): boolean { return this.expanded().has(id); }

  protected toggleExpand(id: number): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.expanded.set(next);
  }

  protected toggleReply(id: number): void {
    this.replyTo.set(this.replyTo() === id ? null : id);
    this.replyDraft.set('');
    this.error.set('');
  }

  protected ago(ts: number): string {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 604800) return `${Math.floor(s / 86400)}d`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected reload(): void { void this.load(this.lesson().id); }

  protected async load(key = this.lesson().id): Promise<void> {
    this.state.set('loading');
    try {
      const r = await this.api.comments(key);
      if (key !== this.lesson().id) return;
      this.rows.set(r.comments);
      this.state.set('ready');
      this.count.emit(r.comments.length);
    } catch {
      if (key !== this.lesson().id) return;
      this.state.set('error');
    }
  }

  protected async post(parent?: number): Promise<void> {
    const body = (parent ? this.replyDraft() : this.draft()).trim();
    if (!body || this.posting()) return;
    this.posting.set(true);
    this.error.set('');
    try {
      await this.api.postComment(this.lesson().id, body, parent);
      if (parent) this.replyDraft.set('');
      else this.draft.set('');
      this.replyTo.set(null);
      await this.load();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not post that.');
    } finally {
      this.posting.set(false);
    }
  }

  protected async like(c: Comment): Promise<void> {
    const id = c.id;
    try {
      const r = await this.api.likeComment(id);
      this.rows.update((rows) => rows.map((x) => (x.id === id ? { ...x, liked: r.liked, likes: r.likes } : x)));
    } catch {
      /* the count simply stays as it was */
    }
  }

  protected async remove(c: Comment): Promise<void> {
    const hasReplies = this.replies(c.id).length > 0;
    if (!confirm(hasReplies ? 'Delete this comment and its replies?' : 'Delete this comment?')) return;
    try {
      await this.api.deleteComment(c.id);
      await this.load();
    } catch {
      this.error.set('Could not delete that comment.');
    }
  }
}