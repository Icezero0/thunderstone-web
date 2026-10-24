import type {PublicPlayerCards, PublicPlayerCard, PlayerListPlayer} from './types.js';

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const byId = (a: PublicPlayerCard, b: PublicPlayerCard) => a.cardId.localeCompare(b.cardId, 'en', {numeric: true}) || a.id.localeCompare(b.id, 'en', {numeric: true});

function playerCards(player: PlayerListPlayer): PublicPlayerCards | undefined {
  if (!player.cards) return undefined;
  const ids = new Set<string>();
  const identity = (card: {id: string; cardId?: string; name?: string}) => {
    if (!text(card.cardId) || !text(card.name)) throw new Error('Visible player cards require a cardId and name.');
    return {id: card.id, cardId: card.cardId, name: card.name};
  };
  const instance = (card: {id: string}) => {
    if (!text(card.id) || ids.has(card.id)) throw new Error('Player card instance IDs must be nonempty and unique across zones.');
    ids.add(card.id);
  };
  const hand = player.cards.hand.map(card => {
    instance(card);
    if (typeof card.revealed !== 'boolean') throw new Error('Hand revealed must be boolean.');
    // Remove hidden identities before they can reach DOM or an image provider.
    return player.isYou || card.revealed ? {...identity(card), revealed: card.revealed} : {id: card.id, revealed: false};
  });
  const inventory = (cards: readonly PublicPlayerCard[]) => cards.map(card => {instance(card); return identity(card);}).sort(byId);
  return {hand, draw: inventory(player.cards.draw), discard: inventory(player.cards.discard)};
}

/** Validate and copy the entire list before updating any visible element. */
export function copyPlayers(players: readonly PlayerListPlayer[]): PlayerListPlayer[] {
  const ids = new Set<string>();
  return players.map(player => {
    if (!text(player.id) || ids.has(player.id) || !text(player.name)) throw new Error('Player identifiers and names must be nonempty; identifiers must be unique.');
    for (const field of ['isYou', 'isActive', 'eliminated'] as const) {
      if (player[field] !== undefined && typeof player[field] !== 'boolean') throw new Error('Player display flags must be boolean.');
    }
    if (player.avatarUrl !== undefined && !text(player.avatarUrl)) throw new Error('Player avatarUrl must be a nonempty string.');
    ids.add(player.id);
    const cards = playerCards(player);
    return {id: player.id, name: player.name, isYou: player.isYou, isActive: player.isActive, eliminated: player.eliminated,
      ...(player.avatarUrl ? {avatarUrl: player.avatarUrl} : {}), ...(cards ? {cards} : {})};
  });
}
