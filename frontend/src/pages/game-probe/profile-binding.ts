import {api} from '../../app/session.js';
import {ApiError} from '../../shared/api/client.js';
import type {User} from '../../shared/api/types.js';

/** Optional account identity for the demo; card components still receive plain snapshots. */
export class ProbeProfileBinding {
  private disposed = false;
  private revision = 0;
  constructor(private receive: (user: User | null) => void) {
    window.addEventListener('focus', this.refresh);
    window.addEventListener('pageshow', this.restored);
    document.addEventListener('visibilitychange', this.visible);
    void this.refresh();
  }
  private refresh = async (): Promise<void> => {
    if (this.disposed) return;
    const revision = ++this.revision;
    try {
      const user = await api.restore();
      if (!this.disposed && revision === this.revision) this.receive(user);
    } catch (error) {
      if (!this.disposed && revision === this.revision && error instanceof ApiError && error.status === 401) this.receive(null);
      // Temporary connection failures retain the last displayed identity and never block the demo.
    }
  };
  private visible = (): void => {if (!document.hidden) void this.refresh();};
  private restored = (event: PageTransitionEvent): void => {if (event.persisted) void this.refresh();};
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.revision++;
    window.removeEventListener('focus', this.refresh);
    window.removeEventListener('pageshow', this.restored);
    document.removeEventListener('visibilitychange', this.visible);
  }
}
