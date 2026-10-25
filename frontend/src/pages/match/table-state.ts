import type {MatchView, MatchCardInstance} from '../../shared/api/types.js';
import type {PublicTableState} from '../../shared/components/public-table-area/index.js';
import type {PlayerDeckState} from '../../shared/components/player-deck-area/index.js';

/** Presentation adaptation only: no setup, purchasing or combat rules. */
export function tableState(view: MatchView): {table: PublicTableState; deck: PlayerDeckState} {
  const card = (item: MatchCardInstance) => ({id: item.instance_id, cardId: item.card_id, name: view.cards[item.card_id]?.name ?? item.card_id,
    ...(item.attachments?.length ? {attachments: item.attachments.map(entry => ({id: entry.instance_id, cardId: entry.card_id,
      kind: entry.kind, name: view.cards[entry.card_id]?.name ?? entry.card_id}))} : {}),
    ...(item.statuses?.length ? {statuses: item.statuses.map(status => ({...status}))} : {})});
  const own = view.players.find(player => player.is_you);
  const control = own?.control ?? [];
  const treasure = (item: MatchCardInstance) => view.cards[item.card_id]?.tags.includes('宝藏');
  const environment = view.settings.find(item => view.cards[item.card_id]?.subcategory === '环境牌');
  return {
    table: {
      dungeon: {environment: environment ? card(environment) : null, dungeons: view.dungeons.map(dungeon => ({
        id: dungeon.id, name: dungeon.id === 'main' ? '地下城' : `地下城 ${dungeon.id.toUpperCase()}`, deckCount: dungeon.deck_count,
        hall: [...Array.from({length: Math.max(3, dungeon.rank_count ?? 3, ...dungeon.hall.map(slot => slot.rank))}, (_, index) => index + 1),
          ...dungeon.hall.filter(slot => slot.rank === 0).map(() => 0)].map(rank => ({rank,
            card: dungeon.hall.find(slot => slot.rank === rank) ? card(dungeon.hall.find(slot => slot.rank === rank)!) : null})),
      }))},
      village: {piles: view.supplies.filter(pile => pile.cards.length).map(pile => {
        const first = view.cards[pile.cards[0].card_id];
        return {id: pile.zone_id, name: pile.name || (pile.kind === 'hero' ? first?.subcategory : first?.name) || first?.name || pile.zone_id,
          kind: pile.kind, cards: pile.cards.map(item => {
            const definition = view.cards[item.card_id], level = definition?.stats['英雄等级'];
            return {cardId: item.card_id, name: definition?.name ?? item.card_id, count: pile.infinite ? null : item.count ?? 0,
              tags: definition?.tags ?? [], ...(level !== undefined ? {level: Number(level)} : pile.kind === 'hero' ? {level: 1} : {})};
          })};
      })},
      players: view.players.map(player => ({id: player.player_id, name: player.display_name,
        isYou: player.is_you, isActive: player.is_active, eliminated: player.eliminated, ...(player.avatar_url ? {avatarUrl: player.avatar_url} : {}),
        ...(player.cards ? {cards: {hand: player.cards.hand.map(item => item.card_id ? {...card(item as MatchCardInstance), revealed: item.revealed}
          : {id: item.instance_id, revealed: false}), draw: player.cards.draw.map(card), discard: player.cards.discard.map(card)}} : {}),
      })),
    },
    deck: {hand: view.hand.map(card), draw: (view.draw ?? []).map(card), discard: view.discard.map(card),
      treasures: control.filter(treasure).map(card), aside: [...control.filter(item => !treasure(item)), ...view.aside ?? []].map(card),
      revealed: (view.revealed ?? []).map(card)},
  };
}
