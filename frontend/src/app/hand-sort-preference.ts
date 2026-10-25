import {api} from './session.js';
import type {User} from '../shared/api/types.js';

/** Account preference, separate from match state. Serial writes preserve rapid toggles. */
export class HandSortPreference {
  private userId: number | null = null;
  private saved = false;
  private desired = false;
  private revision = 0;
  private saving = false;
  private disposed = false;
  constructor(private apply: (enabled: boolean) => void, private report: (message: string) => void,
    private persist: (enabled: boolean) => Promise<User> = enabled => api.request<User>('/users/me',
      {method: 'PATCH', body: JSON.stringify({auto_sort_hand: enabled})})) {}
  receive(user: User | null): void {
    if (this.disposed) return;
    if (this.userId !== (user?.id ?? null)) {
      this.revision++; this.userId = user?.id ?? null;
      this.saved = this.desired = user?.auto_sort_hand ?? false;
    } else if (!this.saving) this.saved = this.desired = user?.auto_sort_hand ?? this.desired;
    this.apply(this.desired);
  }
  change(enabled: boolean): void {
    if (this.disposed) return;
    this.desired = enabled;
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.saving || this.userId === null || this.disposed) return;
    this.saving = true;
    try {
      while (!this.disposed && this.userId !== null && this.saved !== this.desired) {
        const revision = this.revision, requested = this.desired;
        try {
          const result = await this.persist(requested);
          if (revision !== this.revision || this.disposed) return;
          this.saved = result.auto_sort_hand ?? requested;
        } catch {
          if (revision !== this.revision || this.disposed) return;
          if (this.desired !== requested) continue;
          this.desired = this.saved; this.apply(this.saved);
          this.report('自动理牌偏好保存失败，已恢复为上次保存的设置。'); break;
        }
      }
    } finally {
      this.saving = false;
      if (!this.disposed && this.userId !== null && this.saved !== this.desired) void this.flush();
    }
  }
  dispose(): void {this.disposed = true; this.revision++;}
}
