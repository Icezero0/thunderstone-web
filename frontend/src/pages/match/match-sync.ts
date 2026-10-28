import type {RealtimeChange} from '../../shared/realtime/room-connection.js';

/** Coalesce invalidations; a command response already contains its committed version. */
export class MatchSync {
  private wantedVersion = -1;
  private force = false;
  private running = false;
  private disposed = false;
  constructor(private current: () => {id: string; version: number} | null,
    private busy: () => boolean, private refresh: () => Promise<void>) {}

  invalidate(change: RealtimeChange): void {
    if (this.disposed || change.type === 'room_changed') return;
    if (change.type === 'match_changed') {
      const current = this.current(), payload = change.payload;
      if (current && payload?.match_id && payload.match_id !== current.id) return;
      if (typeof payload?.version === 'number' && Number.isSafeInteger(payload.version))
        this.wantedVersion = Math.max(this.wantedVersion, payload.version);
      else this.force = true;
    } else this.force = true; // Profiles may change without advancing a match version.
    this.resume();
  }
  resume(): void {
    if (this.disposed || this.running || this.busy()) return;
    if (this.wantedVersion <= (this.current()?.version ?? -1)) this.wantedVersion = -1;
    if (!this.force && this.wantedVersion < 0) return;
    this.force = false; this.wantedVersion = -1; this.running = true;
    // refresh owns its error presentation. Failure must not cause an unbounded retry loop.
    void this.refresh().catch(() => {}).finally(() => {this.running = false; this.resume();});
  }
  dispose(): void {this.disposed = true;}
}
