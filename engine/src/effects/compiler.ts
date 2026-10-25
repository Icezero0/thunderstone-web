import type {Card, Mechanic} from '../types.js';
import type {Ability, Condition, Expression, Query} from './dsl.js';
import {compileMechanics, FILTER_KEYS, validateFilter} from './mechanics.js';
import {EffectCompileError, allowed, boolean, has, integer, keys, list, nonempty, type ObjectValue} from './validation.js';

export const EFFECTS_SCHEMA_VERSION = 'thunderstone.effects/1';
export const MAX_EFFECT_DEPTH = 16, MAX_EFFECT_NODES = 128;
const words = (value: string): string[] => value ? value.split(' ') : [];
export const QUERY_ZONES = words('active_hand subject_hand active_draw active_discard subject_discard village_supply_top hero_supply_top hall bound event_source active_control event_supply_top active_hand_or_village_top defeated_monster other_hand other_discard subject_control other_control event_hero defeated_this_turn all_discard all_hand reveal_zone collection');
export const ALLOWED_EVENTS = words('ACTION_EXITED TURN_WILL_END DUNGEON_ENTER BATTLE_TEAM_COMMITTED BATTLE_BEFORE_OUTCOME BATTLE_TRIUMPH BATTLE_AFTER_OUTCOME MONSTER_DEFEATED TURN_START VILLAGE_ENTER CARD_PURCHASED HERO_UPGRADED HALL_REVEALED BREACH TRAP_REVEALED HAND_REFILL_COMPLETE CARD_EQUIPPED BEFORE_HALL_REFILL');
const STATS = words('attack magic_attack light strength weight level gold vp health cost xp_reward');
const COMPARISONS = words('eq ne lt le gt ge');
const get = (object: ObjectValue, key: string, fallback: unknown): unknown => has(object, key) ? object[key] : fallback;

export function validateQuery(value: unknown, place = 'query', depth = 0): asserts value is Query {
  if (depth > MAX_EFFECT_DEPTH) throw new EffectCompileError(`${place}: expression too deep`);
  const item = keys(value, ['zone'], [...FILTER_KEYS, ...words('max_by min_by exclude_source var exclude_pile_var compare_stat collection')], place);
  if (has(item, 'collection')) nonempty(item.collection, place);
  if (has(item, 'compare_stat')) {
    const comparison = keys(item.compare_stat, words('field op value'), [], place);
    allowed(comparison.field, words('vp cost health level strength weight'), place, 'invalid stat comparison');
    allowed(comparison.op, words('le lt eq ge gt'), place, 'invalid stat comparison');
    validateExpression(comparison.value, place, depth + 1);
  }
  allowed(item.zone, QUERY_ZONES, place, 'unsupported query zone');
  validateFilter(Object.fromEntries(Object.entries(item).filter(([key]) => FILTER_KEYS.includes(key))));
  if (has(item, 'min_by') && has(item, 'max_by')) throw new EffectCompileError(`${place}: ambiguous extremum query`);
  if (has(item, 'exclude_source')) boolean(item.exclude_source, place);
  if (has(item, 'exclude_pile_var')) nonempty(item.exclude_pile_var, place);
  if (item.zone === 'bound') nonempty(item.var, `${place}.var`);
  for (const key of ['min_by','max_by']) if (has(item, key)) allowed(item[key], words('purchase_cost strength weight attack level gold pile_size'), place, 'unsupported extremum selector');
}
export function validateExpression(value: unknown, place = 'expression', depth = 0): asserts value is Expression {
  if (depth > MAX_EFFECT_DEPTH) throw new EffectCompileError(`${place}: expression too deep`);
  if (typeof value === 'number') {integer(value, place); return;}
  const item = keys(value, [], words('count add mul sub div min max sum maximum resource players stat value context combat'), place);
  if (Object.keys(item).length !== 1) throw new EffectCompileError(`${place}: expression needs one operator`);
  const [op, operand] = Object.entries(item)[0];
  if (op === 'count') validateQuery(operand, `${place}.count`, depth + 1);
  else if (op === 'sum' || op === 'maximum' || op === 'stat') {
    const part = keys(operand, op === 'stat' ? ['var','field'] : ['query','field'], [], place);
    if (op === 'stat') nonempty(part.var, place); else validateQuery(part.query, `${place}.query`, depth + 1);
    allowed(part.field, STATS, place, 'invalid stat');
  } else if (op === 'resource') allowed(operand, ['xp','temporary_gold'], place, 'invalid resource');
  else if (op === 'context') allowed(operand, ['rank','price'], place, 'unsupported event value');
  else if (op === 'players') allowed(operand, ['all','others'], place, 'invalid player scope');
  else if (op === 'combat') allowed(operand, ['attack','magic_attack','light'], place, 'invalid combat value');
  else if (op === 'value') nonempty(operand, place);
  else list(operand, place, 'expected two operands', 2, 2).forEach((part, index) => validateExpression(part, `${place}.${op}[${index}]`, depth + 1));
}
export function validateCondition(value: unknown, place = 'condition', depth = 0): asserts value is Condition {
  if (depth > MAX_EFFECT_DEPTH) throw new EffectCompileError(`${place}: condition too deep`);
  const item = keys(value, [], words('all any not exists compare action_in setting_active choice_is subject_is_active'), place);
  if (Object.keys(item).length !== 1) throw new EffectCompileError(`${place}: condition needs one operator`);
  const [op, operand] = Object.entries(item)[0];
  if (op === 'all' || op === 'any') list(operand, place, 'expected nonempty list', 1).forEach((child, index) => validateCondition(child, `${place}.${op}[${index}]`, depth + 1));
  else if (op === 'not') validateCondition(operand, `${place}.not`, depth + 1);
  else if (op === 'exists') validateQuery(operand, `${place}.exists`);
  else if (op === 'compare') {
    const rule = keys(operand, ['left','op','right'], [], `${place}.compare`);
    allowed(rule.op, COMPARISONS, place, 'invalid comparison');
    validateExpression(rule.left, `${place}.left`); validateExpression(rule.right, `${place}.right`);
  } else if (op === 'action_in') list(operand, place, 'invalid action list', 1).forEach(action => allowed(action, ['village','dungeon','rest'], place, 'invalid action list'));
  else if (op === 'choice_is') {const choice = keys(operand, ['var','option'], [], place); nonempty(choice.var, place); nonempty(choice.option, place);}
  else if (op === 'subject_is_active') boolean(operand, place);
  else nonempty(operand, place);
}

/** Exact allowed fields per operation. No dynamic code or global name lookup. */
const NODE_FIELDS: Readonly<Record<string, readonly [string, string?]>> = {
  sequence: ['children'], if: ['condition then','else'], select: ['query bind then','min max allow_shortfall highest_by constraints'], for_each: ['query bind body'],
  remember: ['query bind then','owners_bind'], choose_value: ['kind bind then','min max scope as_subject options'], reorder: ['query destination'], cost_gate: ['cost then'],
  for_players: ['scope body'], let: ['bind value then'], repeat: ['times limit body'], schedule: ['event body'], reveal: ['count bind then','until from_bottom zone'],
  discard_until: ['filter bind then'],
  copy_hero: ['target other preserve_attack','full_card'], reuse_ability: ['target'], redistribute_discards: ['query','players_var'], borrow_card: ['target when return_destroyed','equipper'],
  equip_from_supply: ['target equipper'], attach_card: ['target anchor kind'], release_attachment: ['target','recipient destroy_anchor'], listen: ['event body','conditions once'],
  swap_hall: ['target other'], exchange_hall: ['target other'], shuffle_hall_top: ['target count'], mod_monster_health: ['target amount'], collect: ['collection query'], clear_collection: ['collection'],
  add_global_rule: ['kind until scope amount'], grant_extra_turn: [''], shuffle_destroyed_traps: [''], grant_basic_buy: [''], remove_listener: [''],
  destroy_matching_supply: ['target count','family from_bottom'], destroy_purchased_supply: [''], destroy_basic_supply: ['card_id count'], random_destroy: ['filter'],
  convert_card_magic: ['target'], grant_turn_buff: ['target buff'], destroy: ['target','as_owner'], discard: ['target','as_owner'], mark_destroy: ['target','when as_owner'], exclude_combat: ['target','as_owner'], show: ['target','as_owner'],
  draw: ['count','bind then'], gain_xp: ['amount'], spend_xp: ['amount'], lose_xp: ['amount'], gain_disease: ['count'], mod_gold: ['amount'], grant_buy: ['amount'], scale_damage: ['divisor'],
  mod_attack: ['amount'], mod_magic_attack: ['amount'], mod_light: ['amount'], random_discard: ['count'], mod_next_hand: ['amount'], mod_next_gold: ['amount'], set_retreat_position: ['amount'],
  force_dungeon: [''], show_hand: [''], buy: ['filter destination','payment maximum_cost may_skip'], upgrade: ['destination','payment'], reveal_cycle: ['filter goal'],
  move: ['target destination','recipient'], relocate_hall: ['target destination','defeat'], destroy_supply: ['target count','from_bottom'], mod_card: ['target stat amount'], set_battle_flag: ['flag value'], gain_card: ['card_id','destination'],
};
export const EFFECT_OPERATIONS = Object.keys(NODE_FIELDS);
function target(value: unknown, place: string): void {nonempty(keys(value, ['var'], [], place).var, place);}
function binding(value: unknown, place: string): void {
  nonempty(value, place);
  if (value === 'source' || value.startsWith('_')) throw new EffectCompileError(`${place}: reserved binding`);
}
function node(value: unknown, place: string, counter: {nodes: number}, depth = 0): ObjectValue {
  if (++counter.nodes > MAX_EFFECT_NODES || depth > MAX_EFFECT_DEPTH) throw new EffectCompileError(`${place}: effect tree exceeds safety bounds`);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !has(value, 'op')) throw new EffectCompileError(`${place}: invalid or missing keys`);
  const op = (value as ObjectValue).op;
  if (typeof op !== 'string' || !has(NODE_FIELDS, op)) throw new EffectCompileError(`${place}: unsupported operation ${op}`);
  const [required, optional = ''] = NODE_FIELDS[op];
  const item = keys(value, ['op', ...words(required)], words(optional), place);
  const choiceKind = item.kind;
  if (op === 'choose_value') keys(item, ['op','kind','bind','then'], words(choiceKind === 'number' ? 'min max' : choiceKind === 'player' ? 'scope as_subject' : choiceKind === 'enum' ? 'options' : ''), place);
  for (const key of ['target','other','anchor','equipper']) if (has(item, key)) target(item[key], place);
  if (has(item, 'bind')) binding(item.bind, place);
  if (has(item, 'owners_bind')) binding(item.owners_bind, place);
  if (has(item, 'players_var')) nonempty(item.players_var, place);
  if (has(item, 'query')) validateQuery(item.query, `${place}.query`);
  if (has(item, 'filter')) validateFilter(item.filter);
  if (has(item, 'card_id')) nonempty(item.card_id, place);
  if (has(item, 'collection')) nonempty(item.collection, place);
  for (const key of ['as_owner','from_bottom','family','preserve_attack','full_card','return_destroyed','destroy_anchor','once','allow_shortfall','as_subject','may_skip']) if (has(item, key)) boolean(item[key], place);
  for (const key of ['amount','times','maximum_cost']) if (has(item, key)) validateExpression(item[key], `${place}.${key}`);
  if (has(item, 'count')) {
    if (op === 'shuffle_hall_top') integer(item.count, place, 0, 100); else validateExpression(item.count, `${place}.count`);
  }
  if (op === 'sequence') list(item.children, place, 'children must be a list').forEach((child, i) => node(child, `${place}.children[${i}]`, counter, depth + 1));
  if (op === 'if') validateCondition(item.condition, `${place}.condition`);
  if (op === 'select') {
    const minimum = get(item, 'min', 1), maximum = get(item, 'max', 1);
    validateExpression(minimum, place); validateExpression(maximum, place);
    if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) throw new EffectCompileError(`${place}: invalid choice bounds`);
    if (has(item, 'highest_by')) allowed(item.highest_by, words('strength weight level attack'), place, 'invalid selection ranking');
    if (has(item, 'constraints')) list(item.constraints, place, 'invalid selection constraints', 0, 1).forEach(value => {
      const constraint = keys(value, ['filter','maximum'], [], place); validateFilter(constraint.filter); integer(constraint.maximum, place, 0, 100);
    });
  }
  if (op === 'choose_value') {
    allowed(choiceKind, words('number player enum dungeon'), place, 'invalid value choice kind');
    if (choiceKind === 'number') {validateExpression(get(item, 'min', 0), place); validateExpression(get(item, 'max', 0), place);}
    if (choiceKind === 'player') allowed(get(item, 'scope', 'all'), ['all','others'], place, 'invalid player choice');
    if (choiceKind === 'enum') {
      const options = list(item.options, place, 'invalid enum choices', 1, 20); options.forEach(value => nonempty(value, place));
      if (new Set(options).size !== options.length) throw new EffectCompileError(`${place}: invalid enum choices`);
    }
  }
  if (op === 'cost_gate' && (!item.cost || typeof item.cost !== 'object' || !['destroy','discard','spend_xp'].includes((item.cost as ObjectValue).op as string))) throw new EffectCompileError(`${place}: cost must be payable atom`);
  if (op === 'for_players') allowed(item.scope, words('all others active'), place, 'unsupported player scope');
  if (op === 'let') validateExpression(item.value, place);
  if (op === 'repeat') integer(item.limit, place, 1, 100);
  if (op === 'scale_damage') integer(item.divisor, place, 1, 100);
  if (op === 'schedule') allowed(item.event, words('TURN_WILL_END TURN_START HAND_REFILL_COMPLETE BATTLE_AFTER_OUTCOME BEFORE_HALL_REFILL'), place, 'unsupported scheduled event');
  if (op === 'listen') {
    allowed(item.event, ALLOWED_EVENTS, place, 'invalid listener');
    list(get(item, 'conditions', []), place, 'conditions must be a list').forEach(condition => validateCondition(condition, place));
  }
  if (op === 'reveal') {
    allowed(get(item, 'zone', 'subject_draw'), ['subject_draw','dungeon'], place, 'invalid reveal zone');
    if (has(item, 'until')) {
      if (!item.until || typeof item.until !== 'object' || Array.isArray(item.until)) throw new EffectCompileError(`${place}: invalid reveal filter`);
      validateQuery({zone: 'bound', var: item.bind, ...item.until}, place);
    }
  }
  if (op === 'reorder') allowed(item.destination, ['draw_top','dungeon_top'], place, 'invalid reorder destination');
  if (op === 'borrow_card') allowed(item.when, ['after_battle','turn_end'], place, 'invalid borrowing contract');
  if (op === 'attach_card') allowed(item.kind, words('cage emerald sapphire disease_before disease_after'), place, 'invalid attachment kind');
  if (op === 'release_attachment') allowed(get(item, 'recipient', 'owner'), ['owner','active'], place, 'invalid attachment release');
  if (op === 'add_global_rule') {
    allowed(item.kind, ['light','force_dungeon'], place, 'invalid global rule'); allowed(item.until, ['owner_next_turn_start','owner_next_turn_end'], place, 'invalid global rule');
    allowed(item.scope, ['all','others'], place, 'invalid global rule'); integer(item.amount, place, 0, 10);
  }
  if (op === 'grant_turn_buff') allowed(item.buff, ['discard_instead_of_destroy'], place, 'unsupported turn buff');
  if (op === 'mark_destroy') allowed(get(item, 'when', 'after_battle'), ['after_battle','turn_end'], place, 'invalid deferred destruction timing');
  if (op === 'draw' && (has(item, 'bind') || has(item, 'then'))) keys(item, ['op','count','bind','then'], [], place);
  if (op === 'buy' || op === 'upgrade') {
    allowed(item.destination, ['hand','discard'], place, `invalid effect ${op === 'buy' ? 'purchase' : 'upgrade'}`);
    allowed(get(item, 'payment', 'none'), op === 'buy' ? ['none','gold','discard_source','destroy_source'] : ['none','discard_source'], place, 'invalid effect payment');
  }
  if (op === 'reveal_cycle') integer(item.goal, place, 1, 10);
  if (op === 'move') {
    if (has(item, 'recipient') && !['active','subject','owner'].includes(item.recipient as string)) target(item.recipient, place);
    allowed(item.destination, words('hand discard draw_top refill_add control'), place, 'invalid move destination');
  }
  if (op === 'relocate_hall') {
    allowed(item.destination, words('dungeon_bottom discard rank3'), place, 'invalid hall destination');
    if (has(item, 'defeat')) {boolean(item.defeat, place); allowed(item.destination, ['discard'], place, 'invalid direct defeat');}
  }
  if (op === 'mod_card') allowed(item.stat, words('attack magic_attack strength light'), place, 'invalid modified stat');
  if (op === 'set_battle_flag') {allowed(item.flag, words('zero_weapon_weight convert_all_magic convert_equipped_magic lose_on_battle_loss cannot_defeat'), place, 'invalid battle flag'); boolean(item.value, place);}
  if (op === 'gain_card') allowed(get(item, 'destination', 'discard'), ['hand','discard'], place, 'invalid card destination');
  for (const key of ['then','else','body','cost']) if (has(item, key)) node(item[key], `${place}.${key}`, counter, depth + 1);
  return item;
}
function references(value: unknown, bound: ReadonlySet<string>, place: string): void {
  if (Array.isArray(value)) value.forEach(child => references(child, bound, place));
  else if (value && typeof value === 'object') {
    const object = value as ObjectValue;
    for (const key of words('var exclude_pile_var value exclude_var name_in_var same_name_as_var adjacent_to_var players_var equippable_by_var')) if (typeof object[key] === 'string' && !bound.has(object[key])) throw new EffectCompileError(`${place}: variable ${object[key]} is not bound`);
    Object.values(object).forEach(child => {if (typeof child === 'object') references(child, bound, place);});
  }
}
function bindings(item: ObjectValue, bound: ReadonlySet<string>, cards: Record<string, Card>, place: string): void {
  references(Object.fromEntries(Object.entries(item).filter(([key]) => !['children','then','else','body','cost'].includes(key))), bound, place);
  const op = item.op;
  if (op === 'sequence') (item.children as ObjectValue[]).forEach((child, i) => bindings(child, bound, cards, `${place}.children[${i}]`));
  else if (['select','for_each','let','reveal','discard_until','choose_value','remember'].includes(op as string) || op === 'draw' && has(item, 'bind')) {
    const child = op === 'for_each' ? item.body : item.then;
    bindings(child as ObjectValue, new Set([...bound, item.bind as string,
      ...(typeof item.owners_bind === 'string' ? [item.owners_bind] : [])]), cards, `${place}.${op}`);
  } else for (const key of ['then','else','body','cost']) if (has(item, key)) bindings(item[key] as ObjectValue, bound, cards, `${place}.${key}`);
  if (op === 'gain_card' && !has(cards, item.card_id as string)) throw new EffectCompileError(`${place}: gained card is not in the catalog`);
}
export interface CompiledRuleset {schema_version: string; abilities: Ability[]; mechanics: Mechanic[]}
/** Validates JSON and returns definitions. Artifact hashing and file loading belong to adapters. */
export function compileRuleset(data: unknown, cards: Record<string, Card>): CompiledRuleset {
  const source = keys(data, ['schema_version','abilities'], ['source_draft','mechanics'], 'ruleset');
  if (source.schema_version !== EFFECTS_SCHEMA_VERSION || !Array.isArray(source.abilities)) throw new EffectCompileError('unsupported effect ruleset schema');
  const seen = new Set<string>();
  const abilities = source.abilities.map((raw, index) => {
    const place = `abilities[${index}]`;
    const item = keys(raw, words('id source_card_id kind source_zone usage conditions body'), ['actions','event','resolution_order'], place);
    const {id, source_card_id: card} = item;
    if (typeof id !== 'string' || typeof card !== 'string' || !id.startsWith(`${card}-A`) || seen.has(id) || !has(cards, card) || cards[card].slot_kind !== 'front') throw new EffectCompileError(`${place}: invalid or duplicate ability source`);
    seen.add(id);
    if (item.kind === 'activated') {
      if (!['active_hand','active_control'].includes(item.source_zone as string) || !['once_per_turn','repeatable'].includes(item.usage as string) || has(item, 'event') || !Array.isArray(item.actions) || !item.actions.length || item.actions.some(action => !['village','dungeon'].includes(action))) throw new EffectCompileError(`${place}: invalid activation`);
    } else if (item.kind === 'triggered') {
      if (!words('settings active_hand active_control attached battle_target hall event_source').includes(item.source_zone as string) || item.usage !== 'once_per_event' || !ALLOWED_EVENTS.includes(item.event as string) || has(item, 'actions')) throw new EffectCompileError(`${place}: invalid trigger`);
    } else throw new EffectCompileError(`${place}: invalid ability kind`);
    if (has(item, 'resolution_order') && (item.kind !== 'triggered' || item.resolution_order !== 'player'))
      throw new EffectCompileError(`${place}: resolution_order requires an explicitly player-ordered trigger`);
    list(item.conditions, place, 'conditions must be a list').forEach((condition, i) => {validateCondition(condition, `${place}.conditions[${i}]`); references(condition, new Set(['source']), place);});
    const body = node(item.body, `${place}.body`, {nodes: 0});
    bindings(body, new Set(['source']), cards, `${place}.body`);
    return {...item, actions: item.actions ?? [], event: item.event ?? null} as unknown as Ability;
  });
  const mechanics = compileMechanics(get(source, 'mechanics', []), cards);
  if (mechanics.some(rule => seen.has(rule.id))) throw new EffectCompileError('duplicate ability and mechanic ID');
  return {schema_version: EFFECTS_SCHEMA_VERSION, abilities, mechanics};
}
