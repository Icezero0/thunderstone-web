import {kinds, extraKinds} from './constants.js';

export function createConfigModel(page) {
  function defaultState() {
    return {
      mode: "classic",
      counts: { village_groups: 8, hero_groups: 4, monster_groups: 3 },
      selection: {
        village: { fixed_randomizer_ids: [] },
        hero: { fixed_randomizer_ids: [] },
        monster: { fixed_randomizer_ids: [] },
        dungeon_features: { mode: "classic_random" },
        guardian: { random_count: 0, fixed_card_ids: [] },
        environment: { random_count: 0, fixed_card_ids: [] },
        trap: { random_count: 0, fixed_group_ids: [] },
        treasure: { random_count: 0, fixed_group_ids: [] },
        thunderstone: { fixed_card_ids: [] },
      },
      instance_multipliers: { village: 1, hero: 1, monster: 1 },
    };
  }

  function environmentRule(config = page.state) {
    const environmentId = config.selection.dungeon_features.mode === "manual"
      ? config.selection.environment.fixed_card_ids[0] : null;
    return page.catalog.environment_rules[environmentId] || null;
  }

  function thunderstoneTarget() {
    return environmentRule()?.thunderstone_target || 1;
  }

  function fixedThunderstoneIds() {
    if (environmentRule()?.scenario === "banishing_ritual") {
      return page.catalog.thunderstones.map(card => card.id);
    }
    return page.state.selection.thunderstone.fixed_card_ids.slice(0, thunderstoneTarget());
  }

  function effectiveCounts(config = page.state) {
    const result = Object.fromEntries(kinds.map(kind => [kind, config.counts[kind + "_groups"]]));
    const rule = environmentRule(config);
    for (const [kind, delta] of Object.entries(rule?.count_delta || {})) result[kind] += delta;
    Object.assign(result, rule?.count_override || {});
    return result;
  }

  function enginePayload() {
    const payload = JSON.parse(JSON.stringify(page.state));
    if (payload.selection.dungeon_features.mode === "classic_random") {
      for (const kind of extraKinds) {
        const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
        payload.selection[kind] = { random_count: 0, [key]: [] };
      }
    }
    payload.selection.thunderstone.fixed_card_ids = fixedThunderstoneIds();
    if (environmentRule()?.scenario === "banishing_ritual") {
      payload.selection.guardian.fixed_card_ids = [...new Set([
        ...payload.selection.guardian.fixed_card_ids, "TS-0683",
      ])];
    }
    return payload;
  }

  return {defaultState, environmentRule, thunderstoneTarget, fixedThunderstoneIds, effectiveCounts, enginePayload};
}
