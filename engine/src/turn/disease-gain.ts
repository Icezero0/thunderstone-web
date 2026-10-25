import {RuleError} from '../types.js';

export interface DiseaseGain {
  instance_id: string;
  player_id: string;
  destination: 'hand'|'draw'|'discard';
  draw_top?: boolean;
  used_sources: string[];
  ability_id?: string|null;
  /** Public identifier for this gain event, never the owned card's instance ID. */
  gain_id?: string;
  /** Public animation origin captured before replacement/redirect continuations. */
  monster_source?: {source_card_id: string; source_hall_zone: string; source_rank: number};
}
export interface DiseaseReplacementRule {
  id: string;
  source_card_id: string;
  action: 'destroy'|'redirect';
}
export interface DiseaseSourceOption {
  source_instance_id: string;
  ability_id: string;
  action: 'destroy'|'redirect';
}
export interface DiseaseChoice {
  kind: string;
  player_id: string;
  stage: string;
  options: DiseaseSourceOption[]|string[];
}
export interface DiseaseGainPlanInput {
  mode: 'advance'|'resolve';
  gain?: DiseaseGain;
  pending_choice?: DiseaseChoice|null;
  resolution_frames?: {kind: string; gain?: DiseaseGain}[];
  instance_exists: boolean;
  instance_count: number;
  player_order: string[];
  players: Record<string, {eliminated?: boolean}>;
  hands: Record<string, string[]>;
  source_card_ids: Record<string, string[]>;
  rules: DiseaseReplacementRule[];
  source_instance_id?: string|null;
  recipient_id?: string|null;
}

export type DiseaseGainAction =
  {op: 'apply_source'; player_id: string; instance_id: string; option: DiseaseSourceOption}|
  {op: 'destroy'; instance_id: string; reason: string}|
  {op: 'redirect'; instance_id: string; from_player_id: string; to_player_id: string; ability_id: string}|
  {op: 'pause'; stage: 'source'|'recipient'; options: DiseaseSourceOption[]|string[]; gain: DiseaseGain}|
  {op: 'complete'; gain: DiseaseGain};
export interface DiseaseGainPlan {
  clear_choice: boolean;
  done: boolean;
  actions: DiseaseGainAction[];
}

function copyGain(gain: DiseaseGain): DiseaseGain {
  return {...gain, used_sources: [...gain.used_sources]};
}

function sameOption(a: DiseaseSourceOption, b: DiseaseSourceOption): boolean {
  return Object.keys(b).length === 3 && a.source_instance_id === b.source_instance_id &&
    a.ability_id === b.ability_id && a.action === b.action;
}

/** Plan a disease-gain continuation without mutating authoritative zones or cards. */
export function planDiseaseGain(input: DiseaseGainPlanInput): DiseaseGainPlan {
  const choice = input.pending_choice;
  if (input.mode === 'resolve' && (!choice || choice.kind !== 'disease_replacement')) {
    throw new RuleError('no disease replacement is pending');
  }
  const frame = input.resolution_frames?.[0];
  if (input.mode === 'resolve' && (input.resolution_frames?.length !== 1 || frame?.kind !== 'disease_gain')) {
    throw new RuleError('invalid disease replacement continuation');
  }
  const sourceGain = input.mode === 'resolve' ? frame?.gain : input.gain;
  if (!sourceGain || !input.instance_exists ||
      (input.mode === 'resolve' && sourceGain.player_id !== choice?.player_id)) {
    throw new RuleError('invalid disease replacement recipient or instance');
  }
  const gain = copyGain(sourceGain), actions: DiseaseGainAction[] = [];
  const result = (done: boolean): DiseaseGainPlan =>
    ({clear_choice: input.mode === 'resolve', done, actions});
  const activePlayers = () => input.player_order.filter(id => !input.players[id]?.eliminated);
  const others = () => activePlayers().filter(id => id !== gain.player_id);
  const sources = (): DiseaseSourceOption[] => {
    const available = others();
    return (input.hands[gain.player_id] ?? []).flatMap(source =>
      gain.used_sources.includes(source) ? [] : input.rules.flatMap(rule =>
        (input.source_card_ids[source] ?? []).includes(rule.source_card_id) &&
        (rule.action !== 'redirect' || available.length > 0) ?
          [{source_instance_id: source, ability_id: rule.id, action: rule.action}] : []));
  };
  const pause = (stage: 'source'|'recipient', options: DiseaseSourceOption[]|string[]) => {
    actions.push({op: 'pause', stage, options, gain: copyGain(gain)});
    return result(false);
  };
  const applySource = (option: DiseaseSourceOption): boolean => {
    gain.used_sources.push(option.source_instance_id);
    gain.ability_id = option.ability_id;
    actions.push({op: 'apply_source', player_id: gain.player_id, instance_id: gain.instance_id, option});
    if (option.action === 'destroy') {
      actions.push({op: 'destroy', instance_id: gain.instance_id, reason: option.ability_id});
      return true;
    }
    return false;
  };
  const redirect = (recipient: string) => {
    const previous = gain.player_id;
    gain.player_id = recipient;
    gain.destination = 'discard';
    actions.push({op: 'redirect', instance_id: gain.instance_id, from_player_id: previous,
      to_player_id: recipient, ability_id: gain.ability_id!});
  };
  const accept = (): DiseaseGainPlan => {
    // Declining optional redirection never overrides mandatory disease removal.
    const mandatory = sources().find(option => option.action === 'destroy');
    if (mandatory) applySource(mandatory);
    else actions.push({op: 'complete', gain: copyGain(gain)});
    return result(true);
  };
  if (input.mode === 'resolve') {
    if (choice!.stage === 'source') {
      const saved = choice!.options as DiseaseSourceOption[];
      if (input.source_instance_id == null && input.recipient_id == null && saved.some(option => option.action === 'redirect')) return accept();
      const selected = sources().find(option =>
        option.source_instance_id === input.source_instance_id && saved.some(item => sameOption(option, item)));
      if (!selected || input.recipient_id != null) throw new RuleError('invalid disease replacement source');
      if (applySource(selected)) return result(true);
      const recipients = others();
      if (!recipients.length) throw new RuleError('disease redirection has no recipient');
      return pause('recipient', recipients);
    } else if (choice!.stage === 'recipient') {
      if (input.source_instance_id == null && input.recipient_id == null) return accept();
      const selected = input.recipient_id;
      if (input.source_instance_id != null || !selected ||
          !(choice!.options as string[]).includes(selected) || !activePlayers().includes(selected)) {
        throw new RuleError('invalid disease redirection recipient');
      }
      redirect(selected);
    } else {
      throw new RuleError('invalid disease replacement continuation');
    }
  }
  const options = sources();
  if (!options.length) {
    actions.push({op: 'complete', gain: copyGain(gain)});
    return result(true);
  }
  if (options.length > 1 && !options.every(option => option.action === 'destroy')) return pause('source', options);
  if (applySource(options[0])) return result(true);
  const recipients = others();
  if (!recipients.length) throw new RuleError('disease redirection has no recipient');
  return pause('recipient', recipients);
}
