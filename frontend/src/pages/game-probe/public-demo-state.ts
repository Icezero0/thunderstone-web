import type {DungeonState, SupplyCard, SupplySelection, VillageState} from '../../shared/components/table-areas/index.js';
import type {PublicTablePlayer} from '../../shared/components/public-table-area/index.js';

export interface DungeonDemoOptions {spire: boolean; forest?: boolean; rankZero: boolean; rankFour: boolean;}

export function createPublicPlayersDemo(): PublicTablePlayer[] {
  const card = (id: string, cardId: string, name: string) => ({id, cardId, name});
  return [{id: 'player-1', name: '玩家 1', isYou: true, isActive: true, avatarUrl: '/avatars/warrior.svg'},
    {id: 'player-2', name: '玩家 2', avatarUrl: '/avatars/mage.svg', cards: {
      hand: [{...card('p2-hand-1', 'TS-0354', '亚马逊弓箭手'), revealed: false},
        {...card('p2-hand-2', 'TS-0003', '火把'), revealed: true},
        {...card('p2-hand-3', 'TS-0272', '火球术'), revealed: false}],
      draw: [card('p2-draw-1', 'TS-0272', '火球术'), card('p2-draw-2', 'TS-0001', '民兵'), card('p2-draw-3', 'TS-0003', '火把')],
      discard: [card('p2-discard-1', 'TS-0238', '战锤'), card('p2-discard-2', 'TS-0002', '匕首')],
    }}, {id: 'player-3', name: '玩家 3', avatarUrl: '/avatars/ranger.svg', cards: {
      hand: [{...card('p3-hand-1', 'TS-0314', '克雷尔战士'), revealed: false},
        {...card('p3-hand-2', 'TS-0001', '民兵'), revealed: true}],
      draw: [card('p3-draw-1', 'TS-0003', '火把'), card('p3-draw-2', 'TS-0002', '匕首')], discard: [],
    }}];
}

/** Fixed visual fixtures. The production engine supplies real halls, reserves and counts. */
export function createDungeonDemo(options: DungeonDemoOptions): DungeonState {
  const dungeons = (options.spire ? ['a', 'b'] : ['main']).map((id, index) => {
    const hall = [
      {rank: 1, card: {id: `${id}-monster-1`, cardId: index ? 'TS-0586' : 'TS-0592', name: index ? '尖刺鞭兽' : '刺脊魔狼'}},
      {rank: 2, card: {id: `${id}-monster-2`, cardId: 'TS-0588', name: '蛇龙畸兽'}},
      {rank: 3, card: {id: `${id}-monster-3`, cardId: 'TS-0510', name: '兽人剑术大师'}},
    ];
    if (options.rankZero) hall.push({rank: 0, card: {id: `${id}-guardian`, cardId: 'TS-0679', name: '死亡哨卫'}});
    if (options.rankFour) hall.push({rank: 4, card: {id: `${id}-monster-4`, cardId: 'TS-0514', name: '兽人督军'}});
    return {id, name: options.spire ? `地下城 ${id.toUpperCase()}` : '主地下城', deckCount: index ? 19 : 27, hall};
  });
  const environment = options.spire ? {id: 'environment', cardId: 'TS-0198', name: '飞龙尖塔'}
    : options.forest ? {id: 'environment', cardId: 'TS-0193', name: '荆棘森林'} : null;
  return {environment, dungeons};
}
const hero = (cardId: string, name: string, level: number, count: number): SupplyCard => ({cardId, name, level, count});

export function createVillageDemo(): VillageState {
  return {piles: [
    {id: 'amazon', name: '亚马逊', kind: 'hero', cards: [hero('TS-0354', '亚马逊弓箭手', 1, 6), hero('TS-0355', '亚马逊女猎手', 2, 4), hero('TS-0356', '亚马逊女王', 3, 2)]},
    {id: 'mage-hunter', name: '猎法者', kind: 'hero', cards: [hero('TS-0336', '猎法者铁拳', 1, 6), hero('TS-0337', '猎法者烈焰', 2, 4), hero('TS-0338', '猎法者凶刃', 3, 2)]},
    {id: 'phalanx', name: '方阵', kind: 'hero', cards: [hero('TS-0328', '方阵步兵', 1, 12), hero('TS-0329', '方阵军官', 2, 3)]},
    {id: 'krell', name: '克雷尔', kind: 'hero', cards: [hero('TS-0314', '克雷尔战士', 1, 8), hero('TS-0315', '克雷尔战领', 2, 5), hero('TS-0316', '克雷尔督军', 3, 3), hero('TS-0317', '克雷尔战争大师', 4, 2)]},
    {id: 'village-thief', name: '村庄盗贼', kind: 'village', cards: [
      {...hero('TS-0301', '村庄扒手', 1, 5), tags: ['盗贼', '英雄', '村庄']},
      {...hero('TS-0300', '村庄强盗', 2, 3), tags: ['盗贼', '英雄', '村庄']},
    ]},
    ...[['TS-0213', '训练师'], ['TS-0214', '贤者'], ['TS-0215', '酒保'],
      ['TS-0238', '战锤'], ['TS-0252', '短剑'], ['TS-0272', '火球术'], ['TS-0280', '预言灵药']].map(([cardId, name]) =>
      ({id: cardId, name, kind: 'village' as const, cards: [{cardId, name, count: 8}]})),
    ...[['TS-0001', '民兵'], ['TS-0002', '匕首'], ['TS-0003', '火把'], ['TS-0004', '应急干粮']].map(([cardId, name]) =>
      ({id: cardId, name, kind: 'basic' as const, cards: [{cardId, name, count: null}]})),
  ]};
}

/** Simulate taking only the exposed card. Basic supplies remain infinite; no purchase rules run. */
export function takeDemoSupply(state: VillageState, selection: SupplySelection): VillageState {
  return {piles: state.piles.map(pile => {
    if (pile.id !== selection.pileId) return pile;
    const top = [...pile.cards].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)).find(card => card.count === null || card.count > 0);
    if (!top || top.cardId !== selection.cardId) throw new Error('Only the exposed supply card may be taken.');
    return {...pile, cards: pile.cards.map(card => card === top && card.count !== null ? {...card, count: card.count - 1} : {...card})};
  })};
}
