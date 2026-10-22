import type {User} from './types.js';

export const SESSION_KEY = 'thunderstone-session-v1';
interface Tokens {access_token: string; refresh_token: string}
type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export class ApiClient {
  private tokens: Tokens | null = null;
  private refreshing: Promise<boolean> | null = null;
  onExpired: (() => void) | null = null;

  constructor(private storage: TokenStorage | null,
              private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(SESSION_KEY) || 'null');
      if (this.isTokens(saved)) this.tokens = saved;
    } catch { /* A browser may disable storage or contain an obsolete session. */ }
  }

  private isTokens(value: unknown): value is Tokens {
    return !!value && typeof value === 'object' && 'access_token' in value && 'refresh_token' in value
      && typeof value.access_token === 'string' && typeof value.refresh_token === 'string';
  }

  private save(tokens: Tokens | null): void {
    this.tokens = tokens;
    try {
      if (tokens) this.storage?.setItem(SESSION_KEY, JSON.stringify(tokens));
      else this.storage?.removeItem(SESSION_KEY);
    } catch { /* The current tab can continue with its in-memory session. */ }
  }

  get accessToken(): string | null {return this.tokens?.access_token ?? null;}
  signOut(): void {this.save(null);}

  async login(email: string, password: string): Promise<User> {
    const tokens = await this.request<Tokens>('/auth/login', {
      method: 'POST', body: JSON.stringify({email, password}),
    }, false);
    if (!this.isTokens(tokens)) throw new Error('登录返回格式异常');
    this.save(tokens);
    return this.request<User>('/users/me');
  }

  async restore(): Promise<User | null> {
    return this.tokens ? this.request<User>('/users/me') : null;
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const token = this.tokens?.refresh_token;
    if (!token) return false;
    this.refreshing = (async () => {
      const response = await this.fetcher('/api/v1/auth/refresh', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({refresh_token: token}),
      });
      if (!response.ok) {
        if (response.status === 401 && this.tokens?.refresh_token === token) {this.save(null); this.onExpired?.();}
        return false;
      }
      const value: unknown = await response.json();
      if (!this.isTokens(value)) throw new Error('登录返回格式异常');
      // A logout while a refresh was in flight must not restore the old session.
      if (this.tokens?.refresh_token !== token) return false;
      this.save(value);
      return true;
    })();
    try {return await this.refreshing;} finally {this.refreshing = null;}
  }

  async request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body) headers.set('Content-Type', 'application/json');
    if (this.tokens) headers.set('Authorization', `Bearer ${this.tokens.access_token}`);
    const response = await this.fetcher(`/api/v1${path}`, {...options, headers});
    if (response.status === 401 && retry && this.tokens && await this.refresh()) {
      return this.request<T>(path, options, false);
    }
    const value = await response.json();
    if (!response.ok) {
      const error = value.error;
      const validation = Array.isArray(value.detail) ? value.detail.map((d: {msg?: string}) => d.msg).join('；') : null;
      throw new ApiError(response.status, error?.code ?? 'request_failed',
        error?.message ?? validation ?? '请求失败，请稍后重试', error?.details);
    }
    return value as T;
  }
}

let storage: TokenStorage | null = null;
try {if (typeof sessionStorage !== 'undefined') storage = sessionStorage;} catch { /* Optional storage. */ }
export const api = new ApiClient(storage);
