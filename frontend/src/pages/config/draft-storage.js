import {STORAGE_KEY, LEGACY_STORAGE_KEYS, kinds, extraKinds} from './constants.js';

export function createDraftStorage(page, {defaultState, effectiveCounts}) {
  function restoreState() {
    try {
      const stored = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]
        .map(key => localStorage.getItem(key)).find(value => value);
      const saved = JSON.parse(stored);
      const draft = saved?.state;
      if (draft?.selection && !draft.selection.guardian) {
        const oldEnvironment = draft.selection.environment?.fixed_card_id;
        for (const kind of ["guardian", "environment"]) {
          draft.selection[kind] = { random_count: 0, fixed_card_ids: [] };
        }
        for (const kind of ["trap", "treasure"]) {
          draft.selection[kind] = { random_count: 0, fixed_group_ids: [] };
        }
        if (typeof oldEnvironment === "string") {
          draft.selection.environment.fixed_card_ids = [oldEnvironment];
        }
        delete draft.selection.dungeon_features;
      }
      for (const kind of ["trap", "treasure"]) {
        const choice = draft?.selection?.[kind];
        if (Array.isArray(choice?.fixed_card_ids) && !choice.fixed_group_ids) {
          choice.fixed_group_ids = [...new Set(choice.fixed_card_ids.map(id =>
            page.catalog.dungeon_groups[kind].find(group => group.members.includes(id))?.id)
            .filter(Boolean))];
          delete choice.fixed_card_ids;
        }
      }
      if (draft?.selection && !draft.selection.dungeon_features) {
        const hasManualChoices = extraKinds.some(kind => {
          const choice = draft.selection[kind];
          const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
          return choice?.random_count > 0 || choice?.[key]?.length > 0;
        });
        draft.selection.dungeon_features = { mode: hasManualChoices ? "manual" : "classic_random" };
      }
      if (draft?.selection?.thunderstone && !Array.isArray(draft.selection.thunderstone.fixed_card_ids)) {
        const oldStone = draft.selection.thunderstone.fixed_card_id;
        draft.selection.thunderstone = { fixed_card_ids: typeof oldStone === "string" ? [oldStone] : [] };
      }
      if (saved?.catalog_hash === page.catalog.catalog_hash && draft?.mode === "classic"
          && draft.counts && draft.selection && draft.instance_multipliers
          && ["classic_random", "manual"].includes(draft.selection.dungeon_features?.mode)
          && kinds.every(kind => Array.isArray(draft.selection[kind]?.fixed_randomizer_ids))
          && ["guardian", "environment"].every(kind => Number.isInteger(draft.selection[kind]?.random_count)
            && Array.isArray(draft.selection[kind]?.fixed_card_ids))
          && ["trap", "treasure"].every(kind => Number.isInteger(draft.selection[kind]?.random_count)
            && Array.isArray(draft.selection[kind]?.fixed_group_ids))
          && Array.isArray(draft.selection.thunderstone?.fixed_card_ids)) {
        for (const kind of kinds) {
          const max = page.catalog.groups[kind].length;
          const value = draft.counts[kind + "_groups"];
          draft.counts[kind + "_groups"] = Number.isInteger(value) ? Math.max(0, Math.min(value, max)) : 0;
          draft.selection[kind].fixed_randomizer_ids = draft.selection[kind].fixed_randomizer_ids
            .slice(0, Math.max(0, Math.min(max, effectiveCounts(draft)[kind])));
        }
        for (const kind of extraKinds) {
          const grouped = kind === "trap" || kind === "treasure";
          const options = grouped ? page.catalog.dungeon_groups[kind] : page.catalog.dungeon_cards[kind];
          const key = grouped ? "fixed_group_ids" : "fixed_card_ids";
          const available = new Set(options.map(option => option.id));
          const fixed = [...new Set(draft.selection[kind][key])]
            .filter(id => available.has(id));
          draft.selection[kind][key] = kind === "environment" ? fixed.slice(0, 1) : fixed;
          const limit = kind === "environment" ? 1 : available.size;
          draft.selection[kind].random_count = Math.max(0, Math.min(
            draft.selection[kind].random_count, limit - draft.selection[kind][key].length));
        }
        if (draft.selection.dungeon_features.mode === "manual"
            && draft.selection.environment.fixed_card_ids[0] === "TS-0199") {
          draft.selection.guardian.fixed_card_ids = draft.selection.guardian.fixed_card_ids
            .filter(id => id !== "TS-0683");
          draft.selection.guardian.random_count = Math.min(
            draft.selection.guardian.random_count,
            page.catalog.dungeon_cards.guardian.length - 1 - draft.selection.guardian.fixed_card_ids.length);
        }
        const stoneIds = new Set(page.catalog.thunderstones.map(card => card.id));
        draft.selection.thunderstone.fixed_card_ids = [...new Set(
          draft.selection.thunderstone.fixed_card_ids)].filter(id => stoneIds.has(id)).slice(0, 2);
        return draft;
      }
    } catch (_) { /* A broken browser-local draft is discarded. */ }
    return defaultState();
  }

  return {restoreState};
}
