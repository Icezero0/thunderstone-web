import {RuleError, type Card, type CardFilter} from '../types.js';

export const FIELDS: Readonly<Record<string, string>> = Object.freeze({
  attack: '正文_基础攻击', magic_attack: '正文_基础魔法攻击', light: 'wiki_光照',
  strength: 'wiki_力量', weight: 'wiki_重量', level: 'wiki_英雄等级', gold: 'wiki_金币值',
  health: 'wiki_生命值', cost: 'wiki_购买价格', vp: 'wiki_胜利点', xp_reward: 'defeat_xp_reward',
});
export const STATS = ['attack', 'magic_attack', 'light', 'strength'] as const;
export const tags = (card: Card): string[] => card.tags.split('|');
export const isHero = (card: Card): boolean => tags(card).includes('英雄');
export const isMilitia = (card: Card): boolean => tags(card).includes('民兵');
export const isMonster = (card: Card): boolean => tags(card).includes('怪物');
export const isDisease = (card: Card): boolean => tags(card).includes('疾病');
export const isThunderstone = (card: Card): boolean => tags(card).includes('雷霆之石');
export const isVillage = (card: Card): boolean => tags(card).includes('村庄');
export function stat(card: Card, key: string): number {
  const raw = card[FIELDS[key] ?? key] ?? '';
  if (/^[+-]?\d+$/.test(raw.trim())) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new RuleError(`unsafe card integer: ${key}`);
    return value;
  }
  if (['attack', 'magic_attack', 'light'].includes(key) && raw === '') {
    // A monster's printed light icon and its unmarked battle text are distinct.
    // Battle light changes are explicit target mechanics, never hand baselines.
    if (key === 'light' && isMonster(card)) return 0;
    const labels: Record<string, string> = {'攻击': 'attack', '魔法攻击': 'magic_attack', '光照': 'light', '光照值': 'light'};
    return (card.effect_text ?? '').split(/\r?\n/).reduce((total, line) => {
      const match = /^(攻击|魔法攻击|光照|光照值) ([+-][0-9]+)。$/.exec(line);
      return total + (match && labels[match[1]] === key ? Number(match[2]) : 0);
    }, 0);
  }
  return 0;
}
export function matches(card: Card, spec: CardFilter): boolean {
  const ownTags = tags(card);
  for (const key of ['card_id', 'card_type', 'subcategory', 'name']) {
    if (key in spec && card[key] !== spec[key]) return false;
  }
  if (spec.exclude_card_id === card.card_id || spec.exclude_card_type === card.card_type) return false;
  if ('tag' in spec && !ownTags.includes(spec.tag as string)) return false;
  if ('tags_any' in spec && !(spec.tags_any as string[]).some(tag => ownTags.includes(tag))) return false;
  if ((spec.tags_none as string[] | undefined)?.some(tag => ownTags.includes(tag))) return false;
  for (const [key, field, direction] of [
    ['gold_min','gold','min'], ['light_min','light','min'], ['level_min','level','min'],
    ['level_max','level','max'], ['gold_max','gold','max'], ['vp_min','vp','min'],
    ['vp_max','vp','max'], ['magic_max','magic_attack','max'], ['magic_min','magic_attack','min'],
    ['weight_min','weight','min'], ['weight_max','weight','max'],
  ]) {
    if (key in spec && (direction === 'min' ? stat(card, field) < (spec[key] as number) : stat(card, field) > (spec[key] as number))) return false;
  }
  for (const field of ['gold','cost','vp']) {
    if (`${field}_present` in spec && ((card[FIELDS[field]] ?? '') !== '') !== spec[`${field}_present`]) return false;
  }
  return true;
}
export function monsterFamily(card: Card): string[] {
  const own = tags(card).filter(tag => !['怪物', '给予疾病'].includes(tag));
  if (own.length === 2 && own[0] === '龙' && ['白龙','绿龙','蓝龙','红龙','黑龙'].includes(own[1])) return ['色彩龙','龙'];
  return [...new Set(own)].sort();
}
