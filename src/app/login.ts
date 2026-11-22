import { ChangeDetectionStrategy, AfterViewInit, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from './api';

declare const google: any;

let gsi: Promise<void> | undefined;
function loadGsi(): Promise<void> {
  return (gsi ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gsi = undefined; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(s);
  }));
}

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormsModule],
  template: `
    <form class="login" role="main" (ngSubmit)="submit()">
      <h1>Sign in</h1>
      <label class="field">
        <span>Email</span>
        <input name="email" type="email" placeholder="you@example.com" autocomplete="username" [(ngModel)]="email" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input name="password" type="password" placeholder="Your password" autocomplete="current-password" [(ngModel)]="password" required />
      </label>
      <p class="err" role="alert">{{ error() }}</p>
      <button class="p" [disabled]="busy()">Sign in</button>
      <div class="or" [hidden]="!hasGoogle()"><span>or</span></div>
      <div class="gsi" #gbtn [hidden]="!hasGoogle()"></div>
    </form>
  `,
})
export class Login implements AfterViewInit {
  private readonly api = inject(Api);
  private readonly gbtn = viewChild.required<ElementRef<HTMLElement>>('gbtn');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly hasGoogle = signal(false);

  async ngAfterViewInit(): Promise<void> {
    // The client id comes from the server (already fetched once at app start) and Google's
    // library is loaded from a third party, so the button cannot render before the view
    // mounts. Show the divider/button slot the moment we know sign-in is on, then drop
    // Google's button into it, so every option is on screen together and the centred form
    // never jumps. No fade: it appears at once.
    // Take a fresh nonce here instead of the cached one: it must match the `gn` cookie now,
    // and a page that has been open for hours (or a second tab) would otherwise fail.
    const { googleClientId: clientId, nonce } = await this.api.freshGoogleConfig();
    if (!clientId) return;
    this.hasGoogle.set(true);
    try {
      await loadGsi();
      google.accounts.id.initialize({
        client_id: clientId,
        // Google echoes this in the ID token; the server checks it against the same-site
        // cookie it issued with the config, so a token minted for another site is rejected.
        nonce,
        ux_mode: 'popup',
        callback: (r: { credential: string }) => void this.google(r.credential),
      });
      const el = this.gbtn().nativeElement;
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      google.accounts.id.renderButton(el, {
        type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large',
        text: 'continue_with', shape: 'pill', logo_alignment: 'left',
        // Flush with the Email/Password/Sign in fields, which are the full form width.
        width: Math.min(400, Math.max(200, el.parentElement?.clientWidth || 300)),
      });
    } catch {
      this.hasGoogle.set(false);
    }
  }

  private async google(credential: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.loginGoogle(credential);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.login(this.email(), this.password());
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
