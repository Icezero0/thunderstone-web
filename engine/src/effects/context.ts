import {RuleError, type BattleContext, type CalculationInput, type Card, type Mechanic} from '../types.js';

export function equipmentPairs(context: BattleContext): [string, string][] {
  return Object.entries(context.equipped_weapon_by_hero ?? {}).flatMap(([hero, weapons]) =>
    (Array.isArray(weapons) ? weapons : [weapons]).map(weapon => [hero, weapon] as [string, string]));
}
/** Read-only access to a caller-owned snapshot. Never consumes RNG or writes it. */
export class Calculation {
  constructor(readonly input: CalculationInput) {}
  get state() {return this.input.state;}
  get mechanics() {return this.input.mechanics;}
  get playerId() {return this.state.active_player_id;}
  get context() {return this.state.battle_context ?? {};}
  hand(): string[] {return this.state.zones[`player:${this.playerId}:hand`] ?? [];}
  card(instanceId: string): Card {
    const copy = this.state.copied_heroes?.[instanceId];
    const cardId = copy?.full_card ? copy.card_ids[0] : this.state.instances[instanceId]?.card_id;
    const card = this.input.cards[cardId];
    if (!card) throw new RuleError(`unknown card instance: ${instanceId}`);
    return card;
  }
  handRules(op?: string): [string, Mechanic][] {
    const sources = new Map<string, string[]>();
    for (const instanceId of this.hand()) {
      const cardIds = [this.card(instanceId).card_id, ...(this.state.copied_heroes?.[instanceId]?.card_ids ?? [])];
      for (const cardId of cardIds) {
        const items = sources.get(cardId) ?? [];
        if (!items.includes(instanceId)) items.push(instanceId);
        sources.set(cardId, items);
      }
    }
    return this.mechanics.filter(rule => !op || rule.op === op).flatMap(rule =>
      (sources.get(rule.source_card_id) ?? []).map(source => [source, rule] as [string, Mechanic]));
  }
  hallRules(op?: string): [string, Mechanic][] {
    const result: [string, Mechanic][] = [];
    for (const [zone, pile] of Object.entries(this.state.zones)) {
      if (!zone.startsWith('hall:')) continue;
      for (const instanceId of pile) {
        for (const rule of this.mechanics) {
          if (this.card(instanceId).card_id === rule.source_card_id && (!op || rule.op === op)
              && (!rule.params.rank0_only || zone.endsWith(':rank0'))) result.push([instanceId, rule]);
        }
      }
    }
    return result;
  }
}
