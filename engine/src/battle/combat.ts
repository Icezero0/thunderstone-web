import {FIELDS, STATS, isHero, isMonster, isDisease, matches, monsterFamily, stat, tags} from '../catalog/cards.js';
import {Calculation, equipmentPairs} from '../effects/context.js';
import {printedGold} from '../effects/economy.js';
import {teamSourceSelected} from './participation.js';
import {weaponAuraApplications} from './weapon-auras.js';
import type {StatusEvidence} from './status-evidence.js';
import {statStatus} from './status-evidence.js';
import {activeGlobalRules} from '../effects/durations.js';
import {effectiveWeight, equipmentCapacity, supportedEquipment, weaponBurden} from './equipment-values.js';
export {effectiveWeight, equipmentCapacity} from './equipment-values.js';
import {RuleError, type CalculationInput, type Card, type CombatTrace, type Mechanic,
  type MechanicParams, type Stats} from '../types.js';

function add(values: Stats, p: Partial<Stats>, multiplier = 1): void {
  for (const field of STATS) values[field] += (p[field] ?? 0) * multiplier;
}
function metric(tx: Calculation, p: MechanicParams, source?: string): number {
  const selected = tx.hand().filter(item => matches(tx.card(item), p.filter ?? {}) && (!p.exclude_source || item !== source));
  let value: number;
  switch (p.metric ?? 'count') {
    case 'gold': value = selected.reduce((sum, item) => sum + printedGold(tx, tx.card(item)), 0); break;
    case 'level_sum': value = selected.reduce((sum, item) => sum + stat(tx.card(item), 'level'), 0); break;
    case 'level_max': value = selected.length ? Math.max(...selected.map(item => stat(tx.card(item), 'level'))) : 0; break;
    case 'xp': value = tx.state.players[tx.playerId].xp; break;
    default: value = selected.length;
  }
  if (p.absent) return Number(value === 0);
  if (value < (p.minimum ?? 0)) return 0;
  return p.flat ? 1 : Math.floor(value / Math.max(1, p.divisor ?? 1));
}
function lightRequirement(tx: Calculation, rank: number, targetRules: Mechanic[], hall: [string, Mechanic][]): number {
  if (rank === 0) return 0;
  let result = Math.max(0, rank);
  if (hall.some(([, rule]) => rule.op === 'hall_aura' && rule.params.double_darkness)) result *= 2;
  for (const rule of targetRules) {
    if (rule.op === 'light_requirement') result = rule.params.ranks?.[String(rank)] ?? result;
  }
  if (tx.state.active_settings.includes('TS-0193')) result = 1;
  else if (tx.state.active_settings.includes('TS-0194')) result = 0;
  return result;
}
export function canEquipWeapon(input: CalculationInput, heroId: string, weaponId: string): boolean {
  return canEquipAtStrength(input, heroId, weaponId, combatValues(input, input.state.battle_context?.target_rank ?? 1).hero_strength[heroId]);
}
function canEquipAtStrength(input: CalculationInput, heroId: string, weaponId: string, strength: number): boolean {
  const tx = new Calculation(input), pairs = equipmentPairs(tx.context);
  if (heroId === weaponId || !tx.hand().includes(heroId) || !isHero(tx.card(heroId))
    || !tags(tx.card(weaponId)).includes('武器') || pairs.some(([, weapon]) => weapon === weaponId)) return false;
  if (weaponBurden(input, heroId, weaponId) > strength) return false;
  const handZone = `player:${tx.playerId}:hand`;
  const projected: CalculationInput = {...input, state: {...input.state,
    zones: {...input.state.zones, [handZone]: [...tx.hand()]},
    battle_context: {...tx.context, equipped_weapon_by_hero: {...tx.context.equipped_weapon_by_hero}}}};
  const hand = projected.state.zones[handZone];
  if (!hand.includes(weaponId)) hand.push(weaponId);
  const context = projected.state.battle_context ??= {}, mapping = context.equipped_weapon_by_hero ??= {};
  const carried = mapping[heroId]; mapping[heroId] = [...(Array.isArray(carried) ? carried : carried ? [carried] : []), weaponId];
  if (mapping[heroId].length > equipmentCapacity(projected, heroId)) return false;
  const wanted = [...pairs, [heroId, weaponId] as [string, string]], valid = combatValues(projected, context.target_rank ?? 1).equipped_pairs;
  return wanted.every(([hero, weapon]) => valid.some(([h, w]) => h === hero && w === weapon));
}

/** Shared preparation-time equipment legality for local drafts and formal commands. */
export function equipmentChoices(input: CalculationInput): {hero_instance_id: string; weapon_instance_id: string}[] {
  const tx = new Calculation(input), hand = tx.hand(), options = [];
  const strength = combatValues(input, tx.context.target_rank ?? 1).hero_strength;
  for (const heroId of hand) {
    const hero = tx.card(heroId);
    if (!isHero(hero)) continue;
    for (const weaponId of hand) {
      if (canEquipAtStrength(input, heroId, weaponId, strength[heroId])) options.push({hero_instance_id: heroId, weapon_instance_id: weaponId});
    }
  }
  return options;
}

/** Pure combat calculation, with effective strength resolved before equipment bonuses. */
export function combatValues(input: CalculationInput, rank: number, target: Card | null = null, evidence?: StatusEvidence): CombatTrace {
  const tx = new Calculation(input), context = tx.context, hand = [...tx.hand()];
  const casts = (id: string): number => tags(tx.card(id)).includes('法术') ? Math.max(1, context.spell_cast_counts?.[id] ?? 1) : 1;
  const targetRules = tx.mechanics.filter(rule => target && rule.source_card_id === target.card_id);
  const heroes = hand.filter(item => isHero(tx.card(item)));
  const values: Record<string, Stats> = Object.fromEntries(hand.map(item =>
    [item, Object.fromEntries(STATS.map(key => [key, stat(tx.card(item), key) * (key === 'strength' ? 1 : casts(item))])) as Stats]));
  for (const [item, copy] of Object.entries(tx.state.copied_heroes ?? {})) {
    if (!(item in values) || copy.full_card) continue;
    if (!copy.preserve_attack) values[item].attack = values[item].magic_attack = 0;
    // Copied text contributes only printed baseline lines, never the target's stats.
    for (const cardId of copy.card_ids) {
      const copied = {...input.cards[cardId]};
      for (const field of ['attack','magic_attack','light']) copied[FIELDS[field]] = '';
      for (const field of ['attack','magic_attack','light'] as const) values[item][field] += stat(copied, field);
    }
  }
  let pairs = equipmentPairs(context).filter(([hero, weapon]) => hand.includes(hero) && hand.includes(weapon));
  const allRules = tx.handRules(), rules = allRules.filter(([source]) => teamSourceSelected(tx, source)), hall = tx.hallRules();
  const strengthPenalties: CombatTrace['strength_penalties'] = [];
  for (const [item, changes] of Object.entries(context.card_modifiers ?? {})) if (values[item]) add(values[item], changes);
  // Strength is a separate dependency stage: equipment thresholds must never
  // depend on the order in which card mechanics happen to be serialized.
  const baseStrength = Object.fromEntries(heroes.map(hero => [hero, values[hero].strength]));
  for (const [source, rule] of allRules) {
    const p = rule.params;
    if (rule.op === 'disease_strength') {
      const chosen = context.strength_penalty_assignments?.[source];
      const targets = p.single ? (heroes.length ? [chosen && heroes.includes(chosen) ? chosen : heroes[0]] : []) : heroes;
      if (p.single) strengthPenalties.push({instance_id: source, hero_instance_id: targets[0] ?? null, amount: p.amount ?? 0});
      for (const hero of targets) {baseStrength[hero] += p.amount ?? 0; evidence?.stats(hero, rule, {strength: p.amount});}
    } else if (rule.op === 'hero_aura' && p.strength) {
      for (const hero of heroes) if (matches(tx.card(hero), p.filter ?? {}) && (!p.exclude_source || hero !== source)
        && (!p.equipped || pairs.some(([h]) => h === hero))) {baseStrength[hero] += p.strength; evidence?.stats(hero, rule, {strength: p.strength});}
    } else if (rule.op === 'hand_bonus' && p.strength && source in baseStrength) {
      const amount = p.strength * metric(tx, p, source); baseStrength[source] += amount; evidence?.stats(source, rule, {strength: amount});
    }
  }
  for (const [, rule] of hall) if (rule.op === 'hall_aura') {
    const p = rule.params, penalty = (p.strength ?? 0) - (p.strength_per_spell ? hand.filter(item => tags(tx.card(item)).includes('法术')).length : 0);
    for (const hero of heroes) {baseStrength[hero] += penalty; evidence?.stats(hero, rule, {strength: penalty});}
  }
  for (const hero of heroes) baseStrength[hero] += context.hero_battle_modifiers?.strength ?? 0;
  for (const rule of targetRules) if (rule.op === 'battle_aura')
    for (const hero of heroes) {baseStrength[hero] += rule.params.strength ?? 0; evidence?.stats(hero, rule, {strength: rule.params.strength});}
  const strengths = (current: [string, string][]) => {
    const result = {...baseStrength};
    for (const [source, rule] of allRules) if (rule.op === 'equipment_bonus' && rule.params.strength) {
      const pair = current.find(([hero, weapon]) => source === hero || source === weapon);
      if (pair) result[pair[0]] += rule.params.strength;
    }
    return result;
  };
  // Dropping a strength-granting weapon can invalidate another weapon; converge
  // by removing unsupported pairs without ever introducing a new pair.
  while (true) {
    const strength = strengths(pairs), supported = supportedEquipment(input, pairs, strength);
    if (supported.length === pairs.length) {
      for (const hero of heroes) values[hero].strength = strength[hero];
      break;
    }
    pairs = supported;
  }
  const validPairs = pairs, equipper = new Map(pairs.map(([hero, weapon]) => [weapon, hero]));
  // Record strength equipment bonuses only after the support fixed point converges.
  for (const [source, rule] of allRules) if (rule.op === 'equipment_bonus' && rule.params.strength) {
    const pair = validPairs.find(([hero, weapon]) => source === hero || source === weapon);
    if (pair) evidence?.stats(pair[0], rule, {strength: rule.params.strength});
  }
  const contribute = (id: string, p: Partial<Stats>, multiplier = 1, rule?: Mechanic) => {
    for (const key of ['attack', 'magic_attack', 'light'] as const) values[id][key] += (p[key] ?? 0) * multiplier * casts(id);
    if (rule) evidence?.stats(id, rule, {attack: p.attack, magic_attack: p.magic_attack, light: p.light}, multiplier * casts(id));
  };
  for (const [source, rule] of rules) {
    const p = rule.params;
    if (rule.op === 'response') values[source].attack += p.attack ?? 0;
    else if (rule.op === 'hero_aura') {
      for (const hero of heroes) if (matches(tx.card(hero), p.filter ?? {}) && (!p.exclude_source || hero !== source)
        && (!p.equipped || pairs.some(([h]) => h === hero))) contribute(hero, p, 1, rule);
    } else if (rule.op === 'card_aura') {
      for (const item of hand) if (p.filters_any?.some(predicate => matches(tx.card(item), predicate))) contribute(item, p, 1, rule);
    } else if (rule.op === 'hand_bonus') contribute(source, p, metric(tx, p, source), rule);
    else if (rule.op === 'draw_attack') {
      if (equipper.has(source)) {const amount = (p.amount ?? 0) * (context.equipment_draw_counts?.[source] ?? 0);
        values[source].attack += amount; evidence?.stats(source, rule, {attack: amount});}
    } else if (rule.op === 'rank_bonus' && (p.minimum ?? 0) <= rank && rank <= (p.maximum ?? 100)) {
      contribute(source, p, p.scale ? rank : 1, rule);
    } else if (rule.op === 'target_bonus' && target) {
      if (rank >= (p.minimum_rank ?? 0) && rank <= (p.maximum_rank ?? Infinity) && (!p.tag || tags(target).includes(p.tag))
        && (!p.same_family || hand.some(item => isMonster(tx.card(item))
          && JSON.stringify(monsterFamily(tx.card(item))) === JSON.stringify(monsterFamily(target))))) contribute(source, p, 1, rule);
    } else if (rule.op === 'equipment_bonus') {
      const relevant: [string, string][] = equipper.has(source) ? [[equipper.get(source)!, source]] : pairs.filter(([hero]) => hero === source);
      for (const [hero, weapon] of relevant) {
        if (p.hero_tag && !p.hero_tag.split('|').some(tag => tags(tx.card(hero)).includes(tag))
          || p.hero_card_id && tx.card(hero).card_id !== p.hero_card_id
          || p.weapon_tag && !tags(tx.card(weapon)).includes(p.weapon_tag)
          || effectiveWeight(input, tx.card(weapon)) > (p.weight_max ?? 100)
          || values[hero].strength < (p.strength_min ?? -100) || rank < (p.minimum_rank ?? 0)) continue;
        if (p.target_tags_any && (!target || !p.target_tags_any.some(tag => tags(target).includes(tag)))) continue;
        contribute(source, p, p.level_scale ? stat(tx.card(hero), 'level') : 1, rule);
        break;
      }
    }
  }
  for (const [, rule] of hall) if (rule.op === 'hall_aura') {
    const p = rule.params;
    if (p.disease_attack) for (const item of hand) if (isDisease(tx.card(item))) {
      values[item].attack += p.disease_attack; evidence?.stats(item, rule, {attack: p.disease_attack});}
  }
  for (const hero of heroes) contribute(hero, context.hero_battle_modifiers ?? {});
  const equipped = new Set(validPairs.map(([, weapon]) => weapon));
  for (const {weapon, rule} of weaponAuraApplications(tx, validPairs)) {add(values[weapon], rule.params); evidence?.stats(weapon, rule, rule.params);}
  const forbidden = new Set(context.excluded_participants ?? []);
  for (const [source, rule] of rules) if (rule.op === 'rank_restriction') {
    const p = rule.params;
    if (p.forbidden?.includes(rank) || p.allowed && !p.allowed.includes(rank)) {forbidden.add(source);
      evidence?.text(source, rule.source_card_id, `不能攻击阶层 ${rank}`, 'debuff');}
  }
  const restrictions: string[] = [], zeroAttack = new Set<string>();
  for (const rule of targetRules) if (rule.op === 'target_restriction') {
    const p = rule.params;
    for (const hero of heroes) if ((p.exclude_tags ?? []).some(tag => tags(tx.card(hero)).includes(tag))
      || Math.max(0, values[hero].strength) < (p.strength_min ?? -100)
      || p.equipped_only && !validPairs.some(([h]) => h === hero)) {forbidden.add(hero);
        evidence?.text(hero, rule.source_card_id, '不能参与对当前怪物的攻击', 'debuff');}
    const immune = (id: string) => {zeroAttack.add(id); evidence?.text(id, rule.source_card_id, '当前怪物免疫此牌的攻击与魔法攻击', 'debuff');};
    if (p.immune_spells) for (const item of hand) if (tags(tx.card(item)).includes('法术')) immune(item);
    if (p.immune_unarmed) for (const hero of heroes) if (!validPairs.some(([h]) => h === hero)) immune(hero);
    if (p.immune_weapon_tag) for (const item of equipped) if (tags(tx.card(item)).includes(p.immune_weapon_tag)) immune(item);
  }
  for (const [hero, weapon] of validPairs) if (forbidden.has(hero)) forbidden.add(weapon);
  for (const item of hand) if (tags(tx.card(item)).includes('武器') && !equipped.has(item)) forbidden.add(item);
  const forcedForbidden = new Set(forbidden);
  for (const item of hand) if (!teamSourceSelected(tx, item)) forbidden.add(item);
  const participatingHeroes = context.battle_team ? heroes.filter(id => !forbidden.has(id)) : heroes;
  const participatingWeapons = context.battle_team ? new Set(validPairs.filter(([hero]) => !forbidden.has(hero)).map(([, weapon]) => weapon)) : equipped;
  if (context.convert_all_magic) {
    for (const item of hand) if (!isDisease(tx.card(item))) {values[item].magic_attack += values[item].attack; values[item].attack = 0;}
  } else if (context.convert_equipped_magic) {
    for (const item of new Set(validPairs.flat())) {values[item].magic_attack += values[item].attack; values[item].attack = 0;}
  }
  for (const item of context.convert_card_magic ?? []) if (values[item]) {values[item].magic_attack += values[item].attack; values[item].attack = 0;}
  for (const item of zeroAttack) values[item].attack = values[item].magic_attack = 0;
  const components: CombatTrace['components'] = hand.filter(item => !forbidden.has(item)
    && (values[item].attack || values[item].magic_attack || values[item].light)).map(item => ({
      instance_id: item, card_id: tx.card(item).card_id, attack: values[item].attack,
      magic_attack: values[item].magic_attack, light: values[item].light,
    }));
  const modifiers = {...context.modifiers};
  for (const m of context.modifier_sources ?? []) if (m.source_instance_id !== null &&
    (forcedForbidden.has(m.source_instance_id) || zeroAttack.has(m.source_instance_id) && ['attack','magic_attack'].includes(m.field)))
    modifiers[m.field] = (modifiers[m.field] ?? 0) - m.amount;
  for (const [index, m] of (context.modifier_sources ?? []).entries()) {
    if (m.source_instance_id !== null && (forcedForbidden.has(m.source_instance_id)
      || zeroAttack.has(m.source_instance_id) && ['attack', 'magic_attack'].includes(m.field))) continue;
    const sourceCard = m.source_card_id ?? (m.source_instance_id ? tx.state.instances[m.source_instance_id]?.card_id : undefined);
    const anchor = m.source_instance_id && hand.includes(m.source_instance_id) ? m.source_instance_id : components[0]?.instance_id;
    if (anchor && sourceCard && m.amount) evidence?.text(anchor, sourceCard, `队伍${statStatus(m.field, m.amount)}`,
      m.amount > 0 ? 'buff' : 'debuff', `resolved:${index}`);
  }
  if (context.convert_all_magic) {modifiers.magic_attack = (modifiers.magic_attack ?? 0) + (modifiers.attack ?? 0); modifiers.attack = 0;}
  let attack = components.reduce((sum, row) => sum + row.attack, 0) + (modifiers.attack ?? 0);
  let magic = components.reduce((sum, row) => sum + row.magic_attack, 0) + (modifiers.magic_attack ?? 0);
  let light = components.reduce((sum, row) => sum + row.light, 0) + (modifiers.light ?? 0);
  const targetInstance = context.target_instance_id ?? Object.entries(tx.state.zones).filter(([zone]) => zone.startsWith('hall:'))
    .flatMap(([, pile]) => pile).find(id => id && tx.card(id).card_id === target?.card_id);
  for (const rule of targetRules) if (rule.op === 'battle_aura') {
    light += rule.params.light ?? 0;
    if (targetInstance && rule.params.light) evidence?.text(targetInstance, rule.source_card_id,
      `本次队伍光照 ${rule.params.light > 0 ? '+' : ''}${rule.params.light}`, rule.params.light > 0 ? 'buff' : 'debuff');
  }
  light += activeGlobalRules(tx.state, 'light').reduce((sum, rule) => sum + rule.amount, 0);
  for (const [source, rule] of hall) if (rule.op === 'hall_aura') {
    light += rule.params.light ?? 0;
    if (rule.params.light) evidence?.text(source, rule.source_card_id,
      `队伍光照 ${rule.params.light > 0 ? '+' : ''}${rule.params.light}`, rule.params.light > 0 ? 'buff' : 'debuff');
  }
  const requirement = lightRequirement(tx, rank, targetRules, hall);
  for (const [source, rule] of rules) if (rule.op === 'excess_light_magic' && !forbidden.has(source) && !zeroAttack.has(source)) {
    const bonus = (rule.params.amount ?? 0) * Math.max(0, light - requirement);
    magic += bonus;
    evidence?.stats(source, rule, {magic_attack: bonus});
    const component = components.find(row => row.instance_id === source);
    if (component) component.magic_attack += bonus;
  }
  // The absence condition sees participating cards' calculated contribution,
  // including dynamic spell bonuses and conversions, before target resistance.
  if (magic <= 0) for (const [source, rule] of rules) if (rule.op === 'no_magic_bonus' && !forbidden.has(source) && !zeroAttack.has(source)) {
    const amount = rule.params.attack ?? 0;
    const converted = context.convert_all_magic || context.convert_equipped_magic && validPairs.flat().includes(source)
      || context.convert_card_magic?.includes(source);
    const field = converted ? 'magic_attack' : 'attack';
    evidence?.stats(source, rule, {[field]: amount});
    const component = components.find(row => row.instance_id === source);
    if (component) component[field] += amount;
    else components.push({instance_id: source, card_id: tx.card(source).card_id, attack: converted ? 0 : amount,
      magic_attack: converted ? amount : 0, light: 0});
    if (converted) magic += amount; else attack += amount;
  }
  const lines = target?.effect_text.split(/\r?\n/) ?? [];
  if (lines.includes('免疫魔法攻击。')) {magic = 0; restrictions.push('immune_magic_attack');
    if (targetInstance) evidence?.text(targetInstance, target!.card_id, '免疫魔法攻击');}
  if (lines.includes('只能使用魔法攻击。')) {attack = 0; restrictions.push('magic_attack_only');
    if (targetInstance) evidence?.text(targetInstance, target!.card_id, '只能使用魔法攻击对其造成伤害');}
  let diseases = hand.filter(item => isDisease(tx.card(item)) && values[item].attack < 0);
  const diseaseOrder = context.disease_order ?? diseases;
  diseases = [...diseaseOrder.filter(item => diseases.includes(item)), ...diseases.filter(item => !diseaseOrder.includes(item))];
  if (!lines.includes('只能使用魔法攻击。')) attack -= diseases.reduce((sum, item) => sum + values[item].attack, 0);
  const penalties: CombatTrace['disease_penalties'] = [];
  for (const item of diseases) {
    let chosen: string | null = context.disease_penalty_assignments?.[item] ?? (attack > 0 ? 'attack' : magic > 0 ? 'magic_attack' : null);
    if (chosen === 'attack' && attack > 0) attack += values[item].attack;
    else if (chosen === 'magic_attack' && magic > 0) magic += values[item].attack;
    else if (attack > 0 || magic > 0) throw new RuleError('disease penalty must target a positive attack type');
    else chosen = null;
    penalties.push({instance_id: item, attack_type: chosen, amount: chosen ? values[item].attack : 0});
  }
  for (const [source, rule] of rules) if (!forbidden.has(source) && rule.op === 'double_magic') {magic *= 2;
    evidence?.text(source, rule.source_card_id, '本次队伍魔法攻击翻倍');}
  let canDefeat = !context.cannot_defeat, canAttack = true;
  // Mammoth's confirmed exception covers every Mammoth copy, so this target
  // restriction deliberately compares definitions rather than source instances.
  for (const [source, rule] of hall) if (rule.op === 'hall_target_restriction' && target
    && target.card_id !== tx.card(source).card_id && tags(target).includes(rule.params.protected_tag as string)) canAttack = false;
  for (const rule of targetRules) if (rule.op === 'target_restriction') {
    const p = rule.params;
    if (targetInstance) evidence?.text(targetInstance, rule.source_card_id, rule.source_line, 'buff', rule.id);
    if (p.half_magic) magic = Math.floor(magic / 2);
    if (p.half_attack_no_magic && magic <= 0) attack = Math.floor(attack / 2);
    if (p.half_attack_no_weapon && !participatingWeapons.size) {
      const combined = Math.floor((attack + magic) / 2); magic = Math.floor(magic / 2); attack = combined - magic;
    }
    if (p.magic_required && magic <= 0 || participatingHeroes.length < (p.min_heroes ?? 0)) canDefeat = false;
    const used = context.used_card_tags ?? [];
    if (p.forbid_used_spell && used.includes('法术') || p.forbid_equipment && participatingWeapons.size) canAttack = false;
    if (p.requires_used_spell_or_item && !used.some(tag => ['法术','物品'].includes(tag))) canDefeat = false;
    if (p.half_no_element && !hand.some(item => tags(tx.card(item)).includes('元素'))) {
      const combined = Math.floor((attack + magic) / 2); magic = Math.floor(magic / 2); attack = combined - magic;
    }
  }
  if ((context.damage_divisor ?? 1) > 1) {
    const divisor = context.damage_divisor!, combined = Math.floor((attack + magic) / divisor);
    magic = Math.floor(magic / divisor); attack = combined - magic;
  }
  let darkness = rank ? Math.max(0, requirement - light) : 0;
  const irreducible = targetRules.some(rule => rule.op === 'light_requirement' && rule.params.irreducible);
  for (const rule of targetRules) if (rule.op === 'light_requirement' && targetInstance)
    evidence?.text(targetInstance, rule.source_card_id, rule.params.irreducible ? '本次战斗的光照惩罚不可抵消' : `当前阶层光照需求：${requirement}`, 'buff');
  if (irreducible) darkness = rank ? requirement : 0;
  let ignore = false;
  for (const [source, rule] of rules) {
    if (forbidden.has(source)) continue;
    const p = rule.params;
    if ((rule.op === 'ignore_darkness' || rule.op === 'target_bonus' && p.ignore_darkness)
      && rank >= (p.minimum_rank ?? 0) && (!p.tag || target && tags(target).includes(p.tag))) {
        ignore = true; if (!irreducible) evidence?.text(source, rule.source_card_id, '本次战斗无视光照惩罚');}
  }
  if (ignore && !irreducible) darkness = 0;
  if (darkness && targetRules.some(rule => rule.op === 'target_restriction' && rule.params.no_darkness)) canAttack = false;
  return {components, modifiers, attack, magic_attack: magic, light, light_requirement: requirement,
    darkness, darkness_penalty: 2 * darkness, effective_attack: Math.max(0, attack + magic - 2 * darkness),
    restrictions, can_defeat: canDefeat, can_attack: canAttack,
    hero_strength: Object.fromEntries(heroes.map(hero => [hero, Math.max(0, values[hero].strength)])),
    equipped_pairs: validPairs, excluded_instance_ids: [...forbidden].sort(), disease_penalties: penalties,
    strength_penalties: strengthPenalties};
}

export function monsterHealth(input: CalculationInput, target: Card, rank = 1, targetId?: string | null, evidence?: StatusEvidence): number {
  const tx = new Calculation(input);
  if (!targetId) {
    const contextual = tx.context.target_instance_id;
    targetId = contextual && tx.state.instances[contextual] && tx.card(contextual).card_id === target.card_id ? contextual
      : Object.entries(tx.state.zones).filter(([zone]) => zone.startsWith('hall:'))
        .flatMap(([, pile]) => pile).find(item => tx.card(item).card_id === target.card_id);
  }
  let result = stat(target, 'health');
  result += (tx.state.attachments?.[targetId ?? ''] ?? []).filter(record => record.kind === 'disease_after').length;
  for (const rule of tx.mechanics) if (rule.source_card_id === target.card_id && rule.op === 'target_health') {
    const p = rule.params;
    if (p.gold_below_double !== undefined) {if (metric(tx, {metric: 'gold'}) < p.gold_below_double) {result *= 2;
      if (targetId) evidence?.text(targetId, rule.source_card_id, '生命值翻倍');}}
    else {
      let value = p.hall_filter ? Object.entries(tx.state.zones).filter(([zone]) => zone.startsWith('hall:')).flatMap(([, pile]) => pile)
        .filter(item => item !== targetId && matches(tx.card(item), p.hall_filter!)).length : metric(tx, p);
      if (p.other_tag) value = Number(tx.hand().some(item => tags(tx.card(item)).includes(p.other_tag!))
        || Object.entries(tx.state.zones).filter(([zone]) => zone.startsWith('hall:')).flatMap(([, pile]) => pile)
          .some(item => item !== targetId && tags(tx.card(item)).includes(p.other_tag!)));
      const amount = value * (p.multiplier ?? 1) + (p.amount ?? 0); result += amount;
      if (targetId) evidence?.stats(targetId, rule, {health: amount});
    }
  }
  // Health auras exclude only their own source instance. hallRules already
  // includes every dungeon and enforces rank-zero restrictions on providers.
  for (const [source, rule] of tx.hallRules('hall_aura')) if (source !== targetId) {result += rule.params.health ?? 0;
    if (targetId) evidence?.stats(targetId, rule, {health: rule.params.health});}
  return Math.max(0, result + (tx.context.health_modifier ?? 0) + (tx.context.monster_health_modifiers?.[targetId ?? ''] ?? 0));
}
