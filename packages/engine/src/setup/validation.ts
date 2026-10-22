import {RuleError} from '../types.js';
import type {GroupCounts, GroupKind, PanelCatalog, SetupRequest} from './contracts.js';
import {effectiveGroupCounts, ENVIRONMENT_SETUP_RULES, GROUP_KINDS, RULESET_VERSION} from './rules.js';

export interface ConfigIssue {path: string; message: string}
export class SetupError extends RuleError {
  constructor(message: string, readonly issues: ConfigIssue[] = []) {super(message); this.name = 'SetupError';}
}
export interface SetupChoice {kind: 'two_dungeons'; group_ids: string[]; feature_ids: string[]; group_a_count: number}
export class SetupChoiceRequired extends SetupError {
  constructor(readonly choice: SetupChoice) {super('setup requires a scenario allocation choice'); this.name = 'SetupChoiceRequired';}
}
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const isObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unique = (value: unknown[]): boolean => new Set(value).size === value.length;

export function validateRulesConfig(payload: unknown, catalog: PanelCatalog): ConfigIssue[] {
  const errors: ConfigIssue[] = [], add = (path: string, message: string): void => {errors.push({path, message});};
  if (!isObject(payload)) return [{path: '$', message: '配置必须是 JSON 对象'}];
  const data = object(payload), counts = object(data.counts), selection = object(data.selection);
  const featureMode = object(selection.dungeon_features).mode;
  if (data.mode !== 'classic') add('mode', '目前只支持 classic 模式');
  if (featureMode !== 'classic_random' && featureMode !== 'manual') add('selection.dungeon_features.mode', '请选择经典随机或手动地下城特征');
  const base: Partial<GroupCounts> = {}, fixedCounts = {} as Record<GroupKind, number>;
  for (const kind of GROUP_KINDS) {
    const countPath = `counts.${kind}_groups`, target = counts[`${kind}_groups`];
    if (!integer(target) || target < 0) add(countPath, '组数必须是非负整数');
    else {
      if (target > catalog.groups[kind].length) add(countPath, '目标组数超过卡牌目录中的可选组数');
      base[`${kind}_groups`] = target;
    }
    let fixed = object(selection[kind]).fixed_randomizer_ids;
    const available = new Set(catalog.groups[kind].map(item => item.id)), path = `selection.${kind}.fixed_randomizer_ids`;
    if (!strings(fixed)) {add(path, '固定组必须是卡牌 ID 列表'); fixed = [];}
    else if (!unique(fixed)) add(path, '固定组不能重复');
    for (const id of fixed as string[]) if (!available.has(id)) add(path, `${id} 不是有效的${kind}设置牌`);
    fixedCounts[kind] = (fixed as string[]).length;
  }
  for (const field of ['guardian','environment'] as const) {
    const item = object(selection[field]), available = new Set(catalog.dungeon_cards[field].map(card => card.id));
    let fixed = item.fixed_card_ids;
    if (!strings(fixed) || !unique(fixed) || fixed.some(id => !available.has(id))) {add(`selection.${field}.fixed_card_ids`, '请选择有效且不重复的实际卡牌'); fixed = [];}
    const count = item.random_count;
    if (!integer(count) || count < 0) add(`selection.${field}.random_count`, '随机种数必须是非负整数');
    else if (count + (fixed as string[]).length > available.size) add(`selection.${field}.random_count`, '随机种数超过未固定的候选卡牌数量');
    if (field === 'environment' && integer(count) && count + (fixed as string[]).length > 1) add('selection.environment', '环境牌最多选择一种');
  }
  for (const field of ['trap','treasure'] as const) {
    const item = object(selection[field]), available = new Set(catalog.dungeon_groups[field].map(group => group.id));
    let fixed = item.fixed_group_ids;
    if (!strings(fixed) || !unique(fixed) || fixed.some(id => !available.has(id))) {add(`selection.${field}.fixed_group_ids`, '请选择有效且不重复的牌组'); fixed = [];}
    const count = item.random_count;
    if (!integer(count) || count < 0) add(`selection.${field}.random_count`, '随机组数必须是非负整数');
    else if (count + (fixed as string[]).length > available.size) add(`selection.${field}.random_count`, '随机组数超过未固定的候选牌组数量');
  }
  let stones = object(selection.thunderstone).fixed_card_ids;
  const allStones = new Set(catalog.thunderstones.map(item => item.id));
  if (!strings(stones) || !unique(stones) || stones.some(id => !allStones.has(id))) {add('selection.thunderstone.fixed_card_ids', '请选择有效且不重复的雷霆之石'); stones = [];}
  if (featureMode === 'classic_random') {
    for (const field of ['guardian','environment','trap','treasure']) {
      const key = field === 'trap' || field === 'treasure' ? 'fixed_group_ids' : 'fixed_card_ids', choice = object(selection[field]);
      if (isObject(selection[field]) && (!(choice.random_count === 0 || choice.random_count === false) || !Array.isArray(choice[key]) || choice[key].length !== 0)) add(`selection.${field}`, '经典随机模式下不能同时指定手动特征');
    }
  }
  if (Object.keys(base).length === 3) {
    const environment = object(selection.environment), fixed = environment.fixed_card_ids;
    const environmentId = featureMode === 'manual' && strings(fixed) && fixed.length === 1 ? fixed[0] : null;
    const effective = effectiveGroupCounts(base as GroupCounts, environmentId);
    for (const kind of GROUP_KINDS) {
      const target = effective[kind];
      if (target < 0 || target > catalog.groups[kind].length) add(`counts.${kind}_groups`, '环境调整后的组数超出可用范围');
      if (fixedCounts[kind] > target) add(`counts.${kind}_groups`, '固定组数超过环境调整后的目标组数');
    }
    const randomEnvironment = featureMode === 'classic_random' || featureMode === 'manual' && (environment.random_count === 1 || environment.random_count === true);
    if (randomEnvironment) for (const kind of GROUP_KINDS) {
      for (const card of catalog.dungeon_cards.environment) {
        const target = effectiveGroupCounts(base as GroupCounts, card.id)[kind];
        if (target < 0 || target > catalog.groups[kind].length) {add(`counts.${kind}_groups`, `随机抽到${card.name}时，组数超出可用范围`); break;}
      }
    }
    const stoneTarget = ENVIRONMENT_SETUP_RULES[environmentId ?? '']?.thunderstone_target ?? 1;
    if ((stones as string[]).length > stoneTarget) add('selection.thunderstone.fixed_card_ids', '固定雷霆之石超过本场景允许数量');
    if (environmentId === 'TS-0199') {
      if ((stones as string[]).length !== allStones.size || (stones as string[]).some(id => !allStones.has(id))) add('selection.thunderstone.fixed_card_ids', '放逐仪式必须选入全部 7 张雷霆之石');
      const guardians = object(selection.guardian).fixed_card_ids;
      if (isObject(selection.guardian) && Array.isArray(guardians) && !guardians.includes('TS-0683')) add('selection.guardian.fixed_card_ids', '放逐仪式必须加入末日之心');
    }
  }
  const multipliers = object(data.instance_multipliers);
  for (const kind of GROUP_KINDS) if (!integer(multipliers[kind]) || Number(multipliers[kind]) < 1 || Number(multipliers[kind]) > 5) add(`instance_multipliers.${kind}`, '倍率必须是 1～5 的整数');
  return errors;
}
export function validateSetupRequest(value: unknown, panel: PanelCatalog): asserts value is SetupRequest {
  if (!isObject(value)) throw new SetupError('setup request must be an object');
  const request = object(value), players = request.player_ids;
  if (!nonempty(request.match_id)) throw new SetupError('match_id must be a nonempty string');
  if (!strings(players) || !players.length || !unique(players) || players.some(id => !nonempty(id) || id.includes(':'))) throw new SetupError("player_ids must be distinct, nonempty IDs without ':'");
  const first = Object.hasOwn(request, 'first_player') ? object(request.first_player) : {mode: 'random'};
  if (!['random','fixed'].includes(first.mode as string) || first.mode === 'fixed' && !players.includes(first.player_id as string)) throw new SetupError('first_player must be random or a fixed participant');
  if (!Object.hasOwn(request, 'rng_seed')) throw new SetupError('rng_seed is required');
  if (Object.hasOwn(request, 'catalog_version') && request.catalog_version !== panel.catalog_hash) throw new SetupError('catalog_version does not match the current card catalog');
  if (Object.hasOwn(request, 'ruleset_version') && request.ruleset_version !== RULESET_VERSION) throw new SetupError('unsupported ruleset_version');
  const issues = validateRulesConfig(request.config, panel);
  if (issues.length) throw new SetupError('invalid rules configuration', issues);
}
