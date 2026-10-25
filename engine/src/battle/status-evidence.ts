import type {CalculationInput, Mechanic, Stats} from '../types.js';

export interface CardStatus {
  kind: 'buff' | 'debuff' | 'destroy';
  source_card_id?: string;
  source_name: string;
  description: string;
  /** Derived from current rule inputs, never a permanent modifier. */
  continuous?: boolean;
}
const labels: Record<string, string> = {strength: '力量', attack: '攻击', magic_attack: '魔法攻击', light: '光照', health: '生命值', gold: '金币', weight: '重量'};
export function statStatus(field: string, amount: number): string {
  return `${labels[field] ?? field} ${amount >= 0 ? '+' : ''}${amount}`;
}

/** Optional calculation evidence. Only branches that actually apply a rule record it. */
export class StatusEvidence {
  private rows = new Map<string, {instance: string; source: string; values: Record<string, number>}>();
  private messages = new Map<string, {instance: string; status: CardStatus}>();
  constructor(private input: CalculationInput) {}
  stats(instance: string, rule: Mechanic, values: Partial<Stats> & {health?: number; gold?: number}, multiplier = 1): void {
    const key = `${instance}\0${rule.id}`, row = this.rows.get(key) ?? {instance, source: rule.source_card_id, values: {}};
    for (const [field, amount] of Object.entries(values)) if (typeof amount === 'number' && amount && multiplier)
      row.values[field] = (row.values[field] ?? 0) + amount * multiplier;
    this.rows.set(key, row);
  }
  text(instance: string, source: string, description: string, kind: CardStatus['kind'] = 'buff', key = description): void {
    this.messages.set(`${instance}\0${source}\0${key}`, {instance, status: this.status(source, description, kind)});
  }
  private status(source: string, description: string, kind: CardStatus['kind']): CardStatus {
    return {kind, ...(this.input.cards[source] ? {source_card_id: source} : {}),
      source_name: this.input.cards[source]?.name ?? '持续效果', description, continuous: true};
  }
  result(): Record<string, CardStatus[]> {
    const output: Record<string, CardStatus[]> = {};
    for (const {instance, source, values} of this.rows.values()) {
      const changes = Object.entries(values).filter(([, amount]) => amount !== 0);
      // Mixed positive and negative effects get separate, accurate categories.
      for (const positive of [true, false]) {
        const parts = changes.filter(([, amount]) => (amount > 0) === positive);
        if (parts.length) (output[instance] ??= []).push(this.status(source,
          parts.map(([field, amount]) => statStatus(field, amount)).join('，'), positive ? 'buff' : 'debuff'));
      }
    }
    for (const {instance, status} of this.messages.values()) (output[instance] ??= []).push({...status});
    return output;
  }
}
