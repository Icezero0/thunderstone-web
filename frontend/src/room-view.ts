import {effectiveGroupCounts} from '@thunderstone/engine';
import type {Catalog, Room} from './types.js';

export function roomPresentation(room: Room, userId: number) {
  const me = room.players.find(player => player.user_id === userId);
  return {isHost: room.host_user_id === userId, isMember: !!me, ready: me?.ready ?? false,
    readyCount: room.players.filter(player => player.ready).length};
}

export function configurationSummary(room: Room, catalog: Catalog | null) {
  const config = room.config;
  const classic = config.selection.dungeon_features.mode === 'classic_random';
  const environment = classic ? null : config.selection.environment.fixed_card_ids[0];
  const counts = effectiveGroupCounts(config.counts, environment);
  const name = (id: string) => catalog?.card_names[id] || id;
  const details: [string, string][] = [];
  for (const [kind, title] of [['village', '村庄'], ['hero', '英雄'], ['monster', '怪物']] as const) {
    const ids = config.selection[kind].fixed_randomizer_ids;
    details.push([title, ids.length ? `${ids.map(name).join('、')}；其余随机` : '全部随机']);
  }
  if (!classic) {
    for (const [kind, title] of [['guardian', '守护者'], ['environment', '环境'], ['trap', '陷阱'], ['treasure', '宝藏']] as const) {
      const choice = config.selection[kind];
      const ids = 'fixed_card_ids' in choice ? choice.fixed_card_ids : choice.fixed_group_ids;
      const values = ids.map(name);
      if (choice.random_count) values.push(`随机 ${choice.random_count} 种`);
      details.push([title, values.join('、') || '不选用']);
    }
  }
  details.push(['雷霆之石', config.selection.thunderstone.fixed_card_ids.map(name).join('、') || '随机选择']);
  return {counts, details, featureMode: classic ? '经典随机' : '手动指定',
    multipliers: `村庄 ×${config.instance_multipliers.village} / 英雄 ×${config.instance_multipliers.hero} / 怪物 ×${config.instance_multipliers.monster}`};
}
