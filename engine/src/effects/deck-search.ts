import type {Transition} from '../turn/transaction.js';

/** Failure records belong to one effect. Successful checks never reset them. */
export class DeckSearchProgress {
  private failures = new Map<string, Map<string, string>>();
  constructor(private readonly tx: Transition) {}

  private signature(instanceId: string): string {
    const instance = this.tx.state.instances[instanceId];
    // Reordering/shuffling does not invalidate a check. A different effective
    // card, owner or instance state does, so that instance can be checked again.
    return JSON.stringify([this.tx.card(instanceId), instance.owner_player_id, instance.flags]);
  }

  recordNoProgress(playerId: string, instanceId: string): void {
    const records = this.failures.get(playerId) ?? new Map<string, string>();
    records.set(instanceId, this.signature(instanceId));
    this.failures.set(playerId, records);
  }

  canContinue(playerIds: string[]): boolean {
    return playerIds.some(playerId => {
      const records = this.failures.get(playerId);
      return [...this.tx.zone('draw', playerId), ...this.tx.zone('discard', playerId)]
        .some(id => records?.get(id) !== this.signature(id));
    });
  }
}
