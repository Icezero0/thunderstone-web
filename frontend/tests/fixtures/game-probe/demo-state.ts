/** Local animation fixtures only. These operations do not implement game rules. */
import type {PlayerDeckCard, PlayerDeckState} from '../../../src/shared/components/player-deck-area/types.js';
export type DemoCard = PlayerDeckCard;
export type DemoState = PlayerDeckState;
export interface DemoChange {state: DemoState; moved: DemoCard[];}
export const MAX_HAND = 30;

const SAMPLES = [
  ['TS-0336', '猎法者铁拳'], ['TS-0001', '民兵'], ['TS-0002', '匕首'],
  ['TS-0003', '火把'], ['TS-0004', '应急干粮'], ['TS-0337', '猎法者烈焰'],
];

export function createDemoState(handCount = 6): DemoState {
  const make = (prefix: string, count: number, offset = 0): DemoCard[] => Array.from({length: count}, (_, index) => {
    const [cardId, name] = SAMPLES[(index + offset) % SAMPLES.length];
    return {id: `${prefix}-${index}`, cardId, name};
  });
  const discard = make('discard', 8);
  discard[7] = {id: 'discard-7', cardId: 'TS-0338', name: '猎法者凶刃'};
  return {hand: make('hand', Math.max(0, Math.min(MAX_HAND, Math.trunc(handCount) || 0))),
    draw: make('draw', 24, 2), discard};
}

export function drawDemoCards(state: DemoState, requested: number): DemoChange {
  const count = Math.max(0, Math.min(Math.trunc(requested) || 0, state.draw.length, MAX_HAND - state.hand.length));
  const moved = state.draw.slice(0, count);
  return {moved, state: {...state, hand: [...state.hand, ...moved], draw: state.draw.slice(count)}};
}

export function discardDemoCards(state: DemoState, ids: ReadonlySet<string>): DemoChange {
  const moved = state.hand.filter(card => ids.has(card.id));
  return {moved, state: {...state, hand: state.hand.filter(card => !ids.has(card.id)),
    discard: [...state.discard, ...moved]}};
}

export function toggleDemoTreasures(state: DemoState): DemoState {
  return {...state, treasures: state.treasures?.length ? [] : [
    {id: 'treasure-demo-1', cardId: 'TS-0700', name: '力量护符'},
    {id: 'treasure-demo-2', cardId: 'TS-0705', name: '蓝宝石龙'},
  ]};
}

/** A visual set-aside/return fixture, including one face-down card when possible. */
export function toggleDemoAside(state: DemoState): DemoState {
  if (state.aside?.length) return {...state, aside: [], hand: [...state.hand, ...state.aside.map(({id, cardId, name}) => ({id, cardId, name}))]};
  const moved = state.hand.slice(0, 2);
  return {...state, hand: state.hand.slice(moved.length), aside: moved.map((card, index) => ({...card, faceUp: index === 0}))};
}
