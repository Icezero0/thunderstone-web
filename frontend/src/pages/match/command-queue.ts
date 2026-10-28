import type {GameCommand, MatchView} from '../../shared/api/types.js';

interface Entry {command: GameCommand; id: string; predicted: MatchView | null}
interface QueueOptions {
  predict: (view: MatchView, command: GameCommand) => MatchView | null;
  matches: (predicted: MatchView, actual: MatchView) => boolean;
  send: (view: MatchView, command: GameCommand, id: string) => Promise<MatchView>;
  show: (view: MatchView, reset: boolean) => void;
  changed: () => void;
  recover: (error: unknown) => Promise<MatchView | null>;
  corrected?: () => void;
}

/** Ordered commands over a confirmed baseline; the browser never owns the saved match. */
export class MatchCommandQueue {
  private confirmed: MatchView | null = null;
  private displayed: MatchView | null = null;
  private entries: Entry[] = [];
  private running = false;
  private recovering = false;
  private generation = 0;
  private retry: {version: number; command: string; id: string} | null = null;
  constructor(private options: QueueOptions) {}
  get pending(): number {return this.entries.length;}
  get synchronizing(): boolean {return this.running || this.pending > 0;}
  get blocked(): boolean {return this.recovering || this.entries.some(entry => !entry.predicted);}
  get baseline(): MatchView | null {return this.confirmed;}
  receive(view: MatchView): void {
    if (this.pending || this.recovering) return;
    if (this.confirmed?.id === view.id && this.confirmed.version > view.version) return;
    this.confirmed = this.displayed = view;
    this.options.show(view, false);
  }
  enqueue(command: GameCommand): boolean {
    if (!this.displayed || this.blocked || this.pending >= 12) return false;
    const predicted = this.options.predict(this.displayed, command);
    const key = JSON.stringify(command);
    const id = !this.pending && this.retry && this.retry.version === this.confirmed?.version && this.retry.command === key ? this.retry.id : crypto.randomUUID();
    this.entries.push({command: structuredClone(command), id, predicted});
    if (predicted) {this.displayed = predicted; this.options.show(predicted, false);}
    this.options.changed();
    void this.drain();
    return true;
  }
  dispose(): void {
    this.generation++; this.entries = []; this.confirmed = this.displayed = null;
    this.recovering = false; this.retry = null;
  }
  private async drain(): Promise<void> {
    if (this.running || !this.confirmed) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.entries.length && this.confirmed) {
        const entry = this.entries[0];
        const actual = await this.options.send(this.confirmed, entry.command, entry.id);
        if (generation !== this.generation) return;
        this.confirmed = actual; this.entries.shift(); this.retry = null;
        if (entry.predicted && !this.options.matches(entry.predicted, actual)) {
          // Do not send commands that depend on an incorrect predicted outcome.
          this.entries = []; this.displayed = actual; this.options.show(actual, true);
          this.options.corrected?.();
        } else if (!this.entries.length) {
          this.displayed = actual; this.options.show(actual, false);
        }
        this.options.changed();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const failed = this.entries[0];
      const rollback = this.displayed?.version !== this.confirmed?.version;
      if (failed && this.confirmed) this.retry = {version: this.confirmed.version, command: JSON.stringify(failed.command), id: failed.id};
      this.entries = []; this.recovering = true; this.options.changed();
      const recovered = await this.options.recover(error);
      if (generation !== this.generation) return;
      if (recovered) {
        this.confirmed = this.displayed = recovered; this.options.show(recovered, rollback); this.recovering = false;
      }
      // Failed recovery stays blocked until an explicit refresh has succeeded.
    } finally {this.running = false; this.options.changed();}
  }
  recovered(view: MatchView): void {
    if (this.running || this.pending) return;
    this.recovering = false; this.confirmed = this.displayed = view; this.options.show(view, true); this.options.changed();
  }
}
