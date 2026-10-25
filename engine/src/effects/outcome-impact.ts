import type {EffectNode} from './dsl.js';

/** Conservative analysis: deferred removal and gains outside hand are outcome-neutral. */
export function affectsBattleOutcome(node: EffectNode | undefined): boolean {
  if (!node) return false;
  switch (node.op) {
    case 'mark_destroy': return false;
    // The current gain_disease atom always gains to discard. Preserve conservative
    // handling if a future DSL extension explicitly requests another destination.
    case 'gain_disease': return node.destination !== undefined && node.destination !== 'discard';
    case 'sequence': return (node.children as EffectNode[]).some(affectsBattleOutcome);
    case 'if': return affectsBattleOutcome(node.then as EffectNode) || affectsBattleOutcome(node.else as EffectNode);
    case 'select': case 'let': case 'remember': return affectsBattleOutcome(node.then as EffectNode);
    case 'for_each': case 'for_players': return affectsBattleOutcome(node.body as EffectNode);
    default: return true;
  }
}
