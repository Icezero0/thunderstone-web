import {RuleError} from '../types.js';
import {RandomStream, RNG_VERSION, wireInteger, type ExactInteger, type RandomState} from '../random/stream.js';

export interface DiseaseSupply {
  disease_infinite: boolean;
  disease_card_ids: string[];
  disease_weights: Record<string, number>;
}

export interface DiseaseSample {
  card_id: string;
  roll: ExactInteger;
  total_weight: ExactInteger;
  candidates: {card_id: string; weight: number}[];
  counter: ExactInteger;
}

/** Select one disease from an infinite supply; instance creation is a separate atom. */
export function sampleDisease(supply: DiseaseSupply, randomState: RandomState): DiseaseSample {
  const weights = supply?.disease_weights, ids = supply?.disease_card_ids;
  if (supply?.disease_infinite !== true || !weights || Array.isArray(weights) || typeof weights !== 'object' ||
      !Array.isArray(ids) || Object.keys(weights).length === 0 ||
      ids.some(id => typeof id !== 'string') ||
      Object.keys(weights).length !== new Set(ids).size ||
      ids.some(id => !Object.hasOwn(weights, id)) ||
      Object.values(weights).some(weight => !Number.isSafeInteger(weight) || weight < 1)) {
    throw new RuleError('invalid disease supply configuration');
  }
  if (randomState.algorithm !== RNG_VERSION) throw new RuleError('unsupported random state');
  const candidates = Object.keys(weights).sort().map(card_id => ({card_id, weight: weights[card_id]}));
  const total = candidates.reduce((sum, item) => sum + BigInt(item.weight), 0n);
  const rng = new RandomStream(randomState.seed, randomState.counter);
  const roll = rng.randbelow(total);
  let remaining = roll, card_id = '';
  for (const candidate of candidates) {
    if (remaining < BigInt(candidate.weight)) {card_id = candidate.card_id; break;}
    remaining -= BigInt(candidate.weight);
  }
  return {card_id, roll: wireInteger(roll), total_weight: wireInteger(total),
    candidates, counter: rng.counter};
}
