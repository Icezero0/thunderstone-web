import {Calculation, equipmentPairs} from '../effects/context.js';
import {isHero, isMonster, tags} from '../catalog/cards.js';
import {ENGINE_VERSION} from '../build-info.js';
import {combatValues, equipmentCapacity, monsterHealth} from './combat.js';
import {RuleError, type CalculationInput, type CombatTrace} from '../types.js';

export interface PreviewContext extends CalculationInput {
  schema_version: 'thunderstone.preview/1';
  engine_version: string;
  game_version: number; catalog_version: string; effects_version: string; player_id: string;
  /** Public sources with a pre-outcome trigger still to execute. No private inputs. */
  battle_effect_sources?: {source_instance_id: string | null; source_zone: string; affects_outcome?: boolean}[];
}
export interface BattlePreview {
  engine_version: string;
  game_version: number; catalog_version: string; effects_version: string;
  target_instance_id: string; rank: number; health: number; calculation: CombatTrace;
  outcome_before_battle_effects: 'win' | 'loss' | 'cannot_attack';
}
/** Target/equipment preview only; active effects and game progression belong to the server. */
export function previewBattle(context: PreviewContext, targetId: string): BattlePreview {
  if (context.schema_version !== 'thunderstone.preview/1' || context.player_id !== context.state.active_player_id) {
    throw new RuleError('unsupported or mismatched preview context');
  }
  if (context.engine_version !== ENGINE_VERSION) throw new RuleError('shared engine version mismatch; reload the preview module');
  const tx = new Calculation(context);
  const entry = Object.entries(tx.state.zones).find(([zone, pile]) => zone.startsWith('hall:') && pile.includes(targetId));
  if (!entry) throw new RuleError('preview target must be in a visible dungeon hall');
  const [zone, pile] = entry, rank = zone.endsWith(':rank0') ? 0 : pile.indexOf(targetId) + 1;
  const target = tx.card(targetId);
  if (!isMonster(target) || target.wiki_生命值 === '') throw new RuleError('preview target is not an attackable monster');
  const pairs = equipmentPairs(tx.context);
  if (new Set(pairs.map(([, weapon]) => weapon)).size !== pairs.length) throw new RuleError('a weapon may only be equipped once');
  for (const [hero, weapon] of pairs) {
    if (hero === weapon || !tx.hand().includes(hero) || !tx.hand().includes(weapon)
      || !isHero(tx.card(hero)) || !tags(tx.card(weapon)).includes('武器')) throw new RuleError('equipment requires a hand hero and a hand weapon');
  }
  for (const hero of new Set(pairs.map(([hero]) => hero))) {
    if (pairs.filter(([owner]) => owner === hero).length > equipmentCapacity(context, hero)) throw new RuleError('hero equipment capacity exceeded');
  }
  const calculation = combatValues(context, rank, target), health = monsterHealth(context, target, rank, targetId);
  return {engine_version: ENGINE_VERSION, game_version: context.game_version, catalog_version: context.catalog_version, effects_version: context.effects_version,
    target_instance_id: targetId, rank, health, calculation,
    outcome_before_battle_effects: !calculation.can_attack ? 'cannot_attack'
      : calculation.can_defeat && calculation.effective_attack >= health ? 'win' : 'loss'};
}
