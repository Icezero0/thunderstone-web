import {planDiseaseGain, type DiseaseGain} from '../turn/disease-gain.js';
import type {Transition} from '../turn/transaction.js';

function input(tx: Transition, mode: 'advance'|'resolve', gain?: DiseaseGain, source?: string|null, recipient?: string|null) {
  const hands = Object.fromEntries(tx.state.player_order.map((player: string) => [player, [...tx.zone('hand', player)]]));
  const sourceIds: Record<string, string[]> = {};
  for (const hand of Object.values(hands) as string[][]) for (const item of hand)
    sourceIds[item] = [...new Set([tx.card(item).card_id, ...(tx.state.copied_heroes?.[item]?.card_ids ?? [])])];
  const frameGain = tx.state.resolution_frames?.[0]?.gain;
  const current = mode === 'resolve' ? frameGain : gain;
  return {mode, gain, pending_choice: tx.state.pending_choice, resolution_frames: tx.state.resolution_frames,
    instance_exists: Boolean(current && tx.state.instances[current.instance_id]),
    instance_count: Object.keys(tx.state.instances).length, player_order: tx.state.player_order,
    players: tx.state.players, hands, source_card_ids: sourceIds,
    rules: tx.ruleset.mechanics.filter(rule => rule.op === 'replace_disease').map(rule =>
      ({id: rule.id, source_card_id: rule.source_card_id, action: rule.params.action as 'destroy'|'redirect'})),
    source_instance_id: source, recipient_id: recipient};
}
function apply(tx: Transition, plan: ReturnType<typeof planDiseaseGain>) {
  if (plan.clear_choice) {tx.state.pending_choice = null; tx.state.resolution_frames = [];}
  for (const action of plan.actions) switch (action.op) {
    case 'apply_source': tx.event('disease_replacement_applied', {player_id: action.player_id,
      instance_id: action.instance_id, ...action.option}); break;
    case 'destroy': tx.destroyCard(action.instance_id, action.reason); break;
    case 'redirect': tx.event('disease_redirected', {instance_id: action.instance_id,
      from_player_id: action.from_player_id, to_player_id: action.to_player_id, ability_id: action.ability_id}); break;
    case 'pause': {
      const current = tx.location(action.gain.instance_id)!;
      if (current.startsWith('player:')) {
        tx.state.instances[action.gain.instance_id].owner_player_id = null;
        tx.move(action.gain.instance_id, current, 'pending:disease');
      }
      tx.state.pending_choice = {kind: 'disease_replacement', player_id: action.gain.player_id,
        ability_id: action.gain.ability_id ?? null, stage: action.stage, options: action.options};
      tx.state.resolution_frames = [{kind: 'disease_gain', gain: structuredClone(action.gain)}];
      tx.state.effect_resume = 'workflow';
      tx.event('disease_replacement_requested', {player_id: action.gain.player_id,
        instance_id: action.gain.instance_id, stage: action.stage, options: action.options});
      break;
    }
    case 'complete': {
      const gain = action.gain, destination = `player:${gain.player_id}:${gain.destination}`;
      tx.state.instances[gain.instance_id].owner_player_id = gain.player_id;
      const current = tx.location(gain.instance_id)!;
      if (current !== destination) tx.move(gain.instance_id, current, destination);
      tx.event('disease_gain_completed', {player_id: gain.player_id, instance_id: gain.instance_id,
        replaced_by: [...gain.used_sources], destination});
      break;
    }
  }
  return plan.done;
}
export function advanceGain(tx: Transition, gain: DiseaseGain) {
  return apply(tx, planDiseaseGain(input(tx, 'advance', gain)));
}
export function resolveReplacement(tx: Transition, source?: string|null, recipient?: string|null) {
  return apply(tx, planDiseaseGain(input(tx, 'resolve', undefined, source, recipient)));
}
