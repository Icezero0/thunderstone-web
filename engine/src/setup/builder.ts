import type {Card} from '../types.js';
import {isThunderstone} from '../catalog/cards.js';
import {orderedSupplyMembers, supplyZone} from '../catalog/supplies.js';
import {RandomStream, type RandomState} from '../random/stream.js';
import type {CatalogGroup, DungeonFeature, FeatureKind, GroupKind, RulesConfig, SetupEvent,
  SetupInput, SetupInstance, SetupRequest, SetupResult, SetupState} from './contracts.js';
import {baseHallCapacity, effectiveCopyCount, effectiveGroupCounts, hallCapacity, MONSTER_MARKERS,
  RULESET_VERSION, SPECIAL_DISEASE_RANDOMIZERS, STARTER_CARDS} from './rules.js';
import {SetupChoiceRequired, SetupError, validateSetupRequest} from './validation.js';
import {validateSetupState} from './state.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface SetupDraft {
  config: RulesConfig; zones: Record<string, string[]>; instances: Record<string, SetupInstance>; events: SetupEvent[];
  selected: Record<GroupKind, string[]>; features: Record<FeatureKind, string[]>;
  group_by_id: Record<string, CatalogGroup>; feature_by_id: Record<string, DungeonFeature>;
  next_instance: number; rng_state: RandomState; pending_feature_draws: number; feature_pool: string[];
}
/** Local setup transaction. The caller owns its snapshot; no worker retains it. */
export class SetupBuilder {
  readonly request: SetupRequest;
  readonly config: RulesConfig;
  readonly rng: RandomStream;
  readonly zones: Record<string, string[]>;
  readonly instances: Record<string, SetupInstance>;
  readonly events: SetupEvent[];
  readonly selected: Record<GroupKind, string[]>;
  readonly features: Record<FeatureKind, string[]>;
  readonly groupById: Record<string, CatalogGroup>;
  readonly featureById: Record<string, DungeonFeature>;
  nextInstance: number;
  pendingFeatureDraws: number;
  featurePool: string[];
  constructor(readonly input: SetupInput, draft?: SetupDraft) {
    this.request = input.request as SetupRequest;
    const copy = draft ? clone(draft) : undefined;
    this.config = copy?.config ?? clone(this.request.config);
    this.rng = new RandomStream(copy?.rng_state.seed ?? this.request.rng_seed, copy?.rng_state.counter ?? 0);
    this.zones = copy?.zones ?? {}; this.instances = copy?.instances ?? {}; this.events = copy?.events ?? [];
    this.selected = copy?.selected ?? {monster: [], hero: [], village: []};
    this.features = copy?.features ?? {guardian: [], environment: [], trap: [], treasure: []};
    this.groupById = copy?.group_by_id ?? Object.fromEntries(input.index.groups.map(group => [group.randomizer_id, group]));
    this.featureById = copy?.feature_by_id ?? Object.fromEntries(input.index.dungeon_features.map(feature => [feature.feature_id, feature]));
    this.nextInstance = copy?.next_instance ?? 1;
    this.pendingFeatureDraws = copy?.pending_feature_draws ?? 0; this.featurePool = copy?.feature_pool ?? [];
  }
  snapshot(): SetupDraft {
    return clone({config: this.config, zones: this.zones, instances: this.instances, events: this.events,
      selected: this.selected, features: this.features, group_by_id: this.groupById, feature_by_id: this.featureById,
      next_instance: this.nextInstance, rng_state: this.rng.snapshot(), pending_feature_draws: this.pendingFeatureDraws, feature_pool: this.featurePool});
  }
  private get environment(): string|undefined {return this.features.environment[0];}
  private event(kind: string, details: Record<string, unknown> = {}): void {
    this.events.push({sequence: this.events.length + 1, kind, ...clone(details)});
  }
  private pick(purpose: string, candidates: string[]): string {
    if (!candidates.length) throw new SetupError(`${purpose}: candidate pool exhausted`);
    const chosen = candidates[this.rng.randbelow(candidates.length)];
    this.event('random_pick', {purpose, candidates, chosen}); return chosen;
  }
  private shuffle(purpose: string, values: string[]): void {
    this.rng.shuffle(values); this.event('shuffle', {purpose, order: values});
  }
  private trimForEnvironment(kind: GroupKind, selected: string[], target: number): void {
    const environment = this.environment;
    if (selected.length > target && (!environment || this.config.selection.environment.fixed_card_ids.includes(environment))) throw new SetupError(`${kind}: fixed groups exceed target`);
    while (selected.length > target) {
      const removed = this.pick(`${kind}_group_removed_by_environment`, selected);
      selected.splice(selected.indexOf(removed), 1);
      this.event('group_removed_by_environment', {category: kind, environment_id: environment ?? null, removed, target});
    }
  }
  create(cardId: string, zone: string, options: {owner?: string|null; origin: string; count?: number}): void {
    const card = this.input.cards[cardId];
    if (!card) throw new SetupError(`unknown card: ${cardId}`);
    const copies = options.count ?? Number(card.initial_copy_count);
    if (!Number.isSafeInteger(copies) || copies < 1) throw new SetupError(`${cardId}: initial_copy_count must be positive`);
    const pile = this.zones[zone] ??= [];
    for (let i = 0; i < copies; i++) {
      const id = `CI-${String(this.nextInstance++).padStart(6, '0')}`;
      this.instances[id] = {card_id: cardId, owner_player_id: options.owner ?? null, origin: options.origin, flags: {}};
      pile.push(id);
    }
  }
  chooseFeature(id: string): void {
    const feature = this.featureById[id], kind = feature.kind;
    this.event('feature', {feature_id: id, action: kind});
    if (kind === 'trap_group' || kind === 'treasure_group') {
      const destination = kind === 'trap_group' ? 'trap' : 'treasure';
      if (!this.features[destination].includes(id)) this.features[destination].push(id);
    } else if (kind === 'draw_guardian') {
      const available = this.input.index.other_pools.guardian.filter(id => !this.features.guardian.includes(id));
      this.features.guardian.push(this.pick('guardian', available));
    } else if (kind === 'draw_environment') {
      if (this.features.environment.length) {this.pendingFeatureDraws++; this.event('feature_redirect', {reason: 'environment_already_exists'});}
      else this.features.environment.push(this.pick('environment', this.input.index.other_pools.environment));
    } else if (kind === 'draw_features') this.pendingFeatureDraws += feature.count!;
    else throw new SetupError(`unhandled dungeon feature ${id}: ${kind}`);
  }
  drawFeatures(count = 1): void {
    this.pendingFeatureDraws = count;
    while (this.pendingFeatureDraws) {
      this.pendingFeatureDraws--;
      const feature = this.pick('dungeon_feature', this.featurePool);
      this.featurePool.splice(this.featurePool.indexOf(feature), 1);
      this.chooseFeature(feature);
    }
  }
  private chooseManualFeatures(): void {
    for (const kind of Object.keys(this.features) as FeatureKind[]) {
      const selection = this.config.selection[kind];
      const chosen = [...('fixed_group_ids' in selection ? selection.fixed_group_ids : selection.fixed_card_ids)];
      for (const item of chosen) this.event('fixed_feature', {category: kind, chosen: item});
      const available = kind === 'trap' || kind === 'treasure' ? this.input.panel.dungeon_groups[kind].map(item => item.id) : this.input.index.other_pools[kind];
      const remaining = available.filter(item => !chosen.includes(item));
      for (let i = 0; i < selection.random_count; i++) {
        const item = this.pick(`manual_${kind}`, remaining); remaining.splice(remaining.indexOf(item), 1); chosen.push(item);
      }
      this.features[kind] = chosen;
    }
  }
  chooseMonsters(): void {
    const selection = this.config.selection;
    this.selected.monster = [...selection.monster.fixed_randomizer_ids];
    for (const item of this.selected.monster) this.event('fixed_group', {category: 'monster', chosen: item});
    if (selection.dungeon_features.mode === 'manual') this.chooseManualFeatures();
    const entry = this.input.index.dungeon_feature_entry.randomizer_id;
    const pool = this.input.index.randomizer_pools.monster_or_feature.filter(item => item !== entry && !this.selected.monster.includes(item));
    if (selection.dungeon_features.mode === 'classic_random') {
      pool.push(...Array<string>(Number(this.input.cards[entry].initial_copy_count)).fill(entry));
      this.featurePool = Object.keys(this.featureById).flatMap(id => Array<string>(Number(this.input.cards[id].initial_copy_count)).fill(id));
    }
    let target: number;
    while (true) {
      target = effectiveGroupCounts(this.config.counts, this.environment).monster;
      this.trimForEnvironment('monster', this.selected.monster, target);
      if (this.selected.monster.length >= target) break;
      const drawn = this.pick('monster_or_feature', pool); pool.splice(pool.indexOf(drawn), 1);
      if (drawn === entry) this.drawFeatures(this.input.index.dungeon_feature_entry.draw_feature_count);
      else {this.selected.monster.push(drawn); this.event('group_selected', {category: 'monster', chosen: drawn});}
    }
    this.event('monster_target', {target, environment_id: this.environment ?? null});
  }
  private chooseGroups(kind: 'hero'|'village'): void {
    const target = effectiveGroupCounts(this.config.counts, this.environment)[kind];
    const selected = [...this.config.selection[kind].fixed_randomizer_ids];
    for (const item of selected) this.event('fixed_group', {category: kind, chosen: item});
    this.trimForEnvironment(kind, selected, target);
    const available = this.input.index.randomizer_pools[kind].filter(item => !selected.includes(item));
    while (selected.length < target) {
      const item = this.pick(`${kind}_group`, available); available.splice(available.indexOf(item), 1); selected.push(item);
      this.event('group_selected', {category: kind, chosen: item});
    }
    this.selected[kind] = selected;
  }
  private chooseStones(): string[] {
    const all = this.input.index.other_pools.thunderstone;
    if (this.environment === 'TS-0199') {const chosen = [...all]; this.event('scenario_stones', {scenario: 'banishing_ritual', chosen}); return chosen;}
    const target = this.environment === 'TS-0198' ? 2 : 1, chosen = [...this.config.selection.thunderstone.fixed_card_ids];
    const remaining = all.filter(item => !chosen.includes(item));
    while (chosen.length < target) {const item = this.pick('thunderstone', remaining); remaining.splice(remaining.indexOf(item), 1); chosen.push(item);}
    this.event('stones_selected', {chosen}); return chosen;
  }
  private materializeSupplies(): void {
    for (const kind of ['village', 'hero'] as const) for (const randomizer of this.selected[kind]) {
      const group = this.groupById[randomizer];
      for (const id of orderedSupplyMembers(group, this.input.cards))
        this.create(id, supplyZone(group, this.input.cards, id), {origin: randomizer, count: effectiveCopyCount(this.input.cards[id], this.config)});
    }
    if (this.features.environment.includes('TS-0197')) {
      const destroyed = this.zones.destroyed ??= [];
      for (const zone of Object.keys(this.zones)) if (zone.startsWith('village_supply:')) {
        const removed = this.zones[zone].splice(0, 2); destroyed.push(...removed);
        this.event('stormhold_supply_destroyed', {zone, instance_ids: removed});
      }
    }
  }
  private dungeonAllocation(): Record<string, string> {
    const groups = this.selected.monster, features = [...this.features.guardian, ...this.features.trap, ...this.features.treasure];
    const choices = this.request.scenario_choices;
    if (choices !== undefined && (!choices || typeof choices !== 'object' || Array.isArray(choices))) throw new SetupError('scenario_choices must be an object');
    const choice = choices?.two_dungeons;
    const prompt = {kind: 'two_dungeons' as const, group_ids: [...groups], feature_ids: features, group_a_count: 2};
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || !Object.hasOwn(choice, 'group_a_ids') || features.length > 0 && !Object.hasOwn(choice, 'group_a_feature_ids')) throw new SetupChoiceRequired(prompt);
    const first = choice.group_a_ids, firstFeatures = Object.hasOwn(choice, 'group_a_feature_ids') ? choice.group_a_feature_ids : [];
    if (!Array.isArray(first) || first.length !== 2 || new Set(first).size !== 2 || first.some(id => !groups.includes(id)) || !Array.isArray(firstFeatures) || new Set(firstFeatures).size !== firstFeatures.length || firstFeatures.some(id => !features.includes(id))) throw new SetupError('invalid two_dungeons allocation');
    this.event('scenario_allocation', {group_a_ids: first, group_a_feature_ids: firstFeatures});
    return Object.fromEntries([...groups.map(id => [id, first.includes(id) ? 'a' : 'b']), ...features.map(id => [id, firstFeatures.includes(id) ? 'a' : 'b'])]);
  }
  private addDungeonMembers(zone: string, group: string, monster: boolean): void {
    const members = monster ? this.groupById[group].members : this.featureById[group].members!;
    const marker = members.find(id => MONSTER_MARKERS.has(id));
    for (const id of members) {
      const destination = monster && marker && id !== marker ? `monster_reserve:${marker}` : zone;
      this.create(id, destination, {origin: group, ...(monster ? {count: effectiveCopyCount(this.input.cards[id], this.config)} : {})});
    }
  }
  private buryGuardians(zone: string, ids: string[]): void {
    if (!ids.length) return;
    const pile = this.zones[zone];
    if (pile.length < 10) throw new SetupError(`${zone}: fewer than 10 cards before guardian placement`);
    const bottom = pile.splice(-10);
    for (const id of ids) this.create(id, zone, {origin: 'guardian_feature'});
    const count = ids.reduce((sum, id) => sum + Number(this.input.cards[id].initial_copy_count), 0);
    bottom.push(...pile.splice(-count)); this.shuffle(`${zone}_guardians`, bottom); pile.push(...bottom);
  }
  private insertStone(zone: string, stone: string, depth: number): void {
    const pile = this.zones[zone];
    if (pile.length < depth) throw new SetupError(`${zone}: fewer than ${depth} cards before stone placement`);
    const bottom = pile.splice(-depth); this.create(stone, zone, {origin: 'thunderstone', count: 1});
    bottom.push(pile.pop()!); this.shuffle(`${zone}_stone_bottom`, bottom); pile.push(...bottom);
  }
  private materializeDungeon(stones: string[]): string[] {
    const environment = this.environment, allocation = environment === 'TS-0198' ? this.dungeonAllocation() : null;
    const decks = allocation ? ['dungeon:a','dungeon:b'] : ['dungeon:main'];
    for (const zone of decks) this.zones[zone] = [];
    for (const group of this.selected.monster) this.addDungeonMembers(allocation ? `dungeon:${allocation[group]}` : 'dungeon:main', group, true);
    for (const kind of ['trap','treasure'] as const) for (const group of this.features[kind]) this.addDungeonMembers(allocation ? `dungeon:${allocation[group]}` : 'dungeon:main', group, false);
    for (const zone of decks) {
      this.shuffle(`${zone}_base`, this.zones[zone]);
      if (environment === 'TS-0199') {
        for (const stone of stones) this.create(stone, zone, {origin: 'banishing_ritual', count: 1});
        this.shuffle('banishing_ritual_stones', this.zones[zone]);
      }
      let guardians = this.features.guardian.filter(id => !allocation || `dungeon:${allocation[id]}` === zone);
      if (environment === 'TS-0199') guardians = guardians.filter(id => id !== 'TS-0683');
      this.buryGuardians(zone, guardians);
    }
    if (environment === 'TS-0198') decks.forEach((zone, index) => this.insertStone(zone, stones[index], 5));
    else if (environment === 'TS-0199') this.create('TS-0683', decks[0], {origin: 'banishing_ritual', count: 1});
    else this.insertStone(decks[0], stones[0], 10);
    return decks;
  }
  fillHall(deckZone: string): void {
    const hallZone = deckZone.replace('dungeon:', 'hall:'), hall = this.zones[hallZone] ??= [], deck = this.zones[deckZone];
    const base = baseHallCapacity(this.features.environment); let target = base, postponed = 0;
    const skipped: string[] = [];
    while (hall.length < target) {
      if (!deck.length || postponed >= deck.length) {
        if (target > base && hall.length >= base) {this.event('setup_hall_deck_exhausted', {hall_zone: hallZone, missing: target - hall.length}); break;}
        throw new SetupError(`${deckZone}: cannot fill initial hall with ${target} cards`);
      }
      let id: string|null = deck.shift()!, cardId = this.instances[id].card_id;
      if (MONSTER_MARKERS.has(cardId)) {
        (this.zones.monster_markers ??= []).push(id);
        const replacement = this.zones[`monster_reserve:${cardId}`]?.shift() ?? null;
        this.event('monster_marker_replaced', {marker_instance_id: id, instance_id: replacement, at_setup: true});
        id = replacement;
      }
      if (id === null) continue;
      cardId = this.instances[id].card_id;
      const category = this.input.cards[cardId].subcategory;
      if (category === '陷阱' || category === '宝藏') {deck.push(id); postponed++; this.event('setup_hall_postponed', {instance_id: id}); continue;}
      const stone = isThunderstone(this.input.cards[cardId]);
      if (stone || category === '守护者') {skipped.push(id); this.event(category === '守护者' ? 'setup_hall_guardian_skipped' : 'setup_hall_stone_skipped', {deck_zone: deckZone, instance_id: id}); continue;}
      if (category !== '怪物') throw new SetupError(`${deckZone}: invalid initial hall card ${id}`);
      hall.push(id); target = hallCapacity(hall.map(item => this.instances[item].card_id), this.features.environment); postponed = 0;
    }
    deck.unshift(...skipped); this.event('hall_filled_at_setup', {hall_zone: hallZone, instance_ids: hall});
  }
  private materializePlayers(): void {
    for (const player of this.request.player_ids) {
      const draw = `player:${player}:draw`, hand = `player:${player}:hand`;
      for (const part of ['draw','hand','discard','control']) this.zones[`player:${player}:${part}`] = [];
      for (const [id, count] of Object.entries(STARTER_CARDS)) this.create(id, draw, {owner: player, origin: 'starter_deck', count});
      this.shuffle(`${player}_starter`, this.zones[draw]); this.zones[hand].push(...this.zones[draw].splice(0, 6));
      this.event('initial_hand_drawn', {player_id: player, instance_ids: this.zones[hand]});
    }
  }
  build(): SetupResult {
    this.chooseMonsters(); this.chooseGroups('hero'); this.chooseGroups('village');
    for (const [kind, target] of Object.entries(effectiveGroupCounts(this.config.counts, this.environment)) as [GroupKind, number][]) {
      if (this.selected[kind].length !== target) throw new SetupError(`${kind}: selected ${this.selected[kind].length}, expected ${target}`);
    }
    const stones = this.chooseStones(); this.materializeSupplies();
    for (const deck of this.materializeDungeon(stones)) this.fillHall(deck);
    for (const id of this.features.environment) this.create(id, 'settings', {origin: 'environment', count: 1});
    this.materializePlayers();
    const first = this.request.first_player ?? {mode: 'random'}, firstId = first.mode === 'random' ? this.pick('first_player', this.request.player_ids) : first.player_id!;
    const mode = [...this.selected.monster, ...this.selected.hero].some(id => SPECIAL_DISEASE_RANDOMIZERS.has(id)) ? 'special' : 'normal';
    const diseases = this.input.index.other_pools.disease.filter(id => this.input.cards[id].tags.split('|').includes('特殊') === (mode === 'special'));
    if (!diseases.length) throw new SetupError(`no disease cards for ${mode} mode`);
    const weights = Object.fromEntries(diseases.map(id => [id, Number(this.input.cards[id].initial_copy_count)]));
    if (Object.values(weights).some(weight => !Number.isSafeInteger(weight) || weight < 1)) throw new SetupError(`invalid disease weights for ${mode} mode`);
    this.event('disease_mode', {mode, card_ids: diseases, weights}); this.event('setup_complete', {first_player_id: firstId});
    const state: SetupState = {
      match_id: this.request.match_id, game_version: 1, catalog_version: this.input.panel.catalog_hash, ruleset_version: RULESET_VERSION,
      effects_version: this.input.effects_version, frozen_config_id: this.input.frozen_config_id, frozen_config: this.config,
      player_order: [...this.request.player_ids], first_player_id: firstId, active_player_id: firstId,
      turn_number: 1, round_number: 1, phase: 'PLAYING', subphase: 'TURN_START', timing_window: 'TURN_START_BEFORE', chosen_action: null,
      turn_hand_public: true,
      players: Object.fromEntries(this.request.player_ids.map(id => [id, {xp: 0, temporary_gold: 0, purchases_remaining: 1}])),
      zones: this.zones, instances: this.instances, selected_groups: this.selected, selected_features: this.features,
      selected_thunderstones: stones, active_settings: [...this.features.environment],
      supply_rules: {basic_card_ids: Object.keys(STARTER_CARDS), basic_infinite: true, disease_mode: mode,
        disease_card_ids: diseases, disease_weights: weights, disease_infinite: true},
      continuous_effects: [], registered_triggers: [], scheduled_effects: [], battle_context: null,
      pending_choice: null, resolution_frames: [], end_condition: null, rng_state: this.rng.snapshot(),
      next_instance_sequence: this.nextInstance, next_event_sequence: this.events.length + 1,
    };
    validateSetupState(state, this.input.cards); return {state, events: this.events};
  }
}
export function startGame(input: SetupInput): SetupResult {
  validateSetupRequest(input.request, input.panel);
  return new SetupBuilder(input).build();
}
