# Battle team API

The former stateless HTTP sandbox routes listed below are retained only in
isolated test applications. Since 2026-10-25 the deployed backend returns 404 for
`/api/v1/battle/context` and `/api/v1/battle/submit`. Formal matches use the
authenticated match view and command endpoints; shared engine interfaces remain unchanged.

## State and ownership

The backend owns `GameState`. During uninterrupted `DUNGEON_PREPARE` or `DUNGEON_DECLARE`, it calls
`battlePreparation(state, playerId, catalog, ruleset)` and sends the returned
`{context, options, draft}` to the active player. The context contains that player's
hand, public halls and environment settings, relevant card definitions and calculation rules. It excludes
draw piles, opponents' hands, RNG, private flags and effect continuations.

The frontend edits `BattleDraft` locally. Each click calls `updateBattleDraft` and
`previewBattleTeam` from the same `@thunderstone/engine` package used on the server.
These functions do not change the match, consume RNG, execute abilities or send
requests. Preparation defaults select all hand heroes and optional support, retaining
equipment; the formal client starts with empty selections. During declaration the
returned draft contains the committed team, including after reconnecting.

After an authoritative ability, draw or other state change, obtain a fresh context
for the new `game_version`. The server rejects drafts built for an older version.

## Shared TypeScript interface

All functions and types below are exported from `engine`. The local
backend serves the browser ESM bundle at `/engine/engine.js`.

| Function | Result |
| --- | --- |
| `battlePreparation(state, playerId, catalog, ruleset)` | Validated visible `context`, selection `options`, initial `draft`; server entry point |
| `createBattleDraft(context, targetId = null)` | New local draft |
| `battleTeamOptions(context)` | Hero, support, weapon, mandatory hand and target instance IDs |
| `updateBattleDraft(context, draft, action)` | New validated draft, leaving both inputs unchanged |
| `previewBattleTeam(context, draft)` | Attack, magic attack, light, hero strength, equipment, penalties, target health and provisional outcome |
| `buildSubmitBattleTeamCommand(context, draft)` | Versioned `SubmitBattleTeam` command |
| `applyCommand(state, command, catalog, ruleset)` | Authoritative new state, ordered events and legal commands |

`BattleDraft` carries the following fields:

```typescript
interface BattleDraft {
  schema_version: 'thunderstone.battle-draft/1';
  engine_version: string;
  game_version: number;
  catalog_version: string;
  effects_version: string;
  player_id: string;
  hero_instance_ids: string[];
  support_instance_ids: string[];
  equipment: Record<string, string[]>; // hero instance -> weapon instances
  target_instance_id: string | null;
}
```

Selected and unselected cards all remain in the player's hand, including equipped
weapons. `battle_context.battle_team` records participation by instance ID;
`equipped_weapon_by_hero` records equipment relationships. Neither creates a card
zone or changes ownership. A hand-targeting effect sees both selected and
unselected cards; only an explicit participation condition narrows that scope.

Spells and other non-weapon support cards are
selected in `support_instance_ids` and need no hero. Equipment can belong to any hand
hero; deselecting that hero retains the equipment but removes its combat contribution. Diseases, monster hand
trophies and thunderstones are mandatory hand cards and cannot be disabled as support.

Actions accepted by `updateBattleDraft`:

```typescript
type BattleDraftAction =
  | {type: 'set_hero' | 'set_support'; instance_id: string; selected: boolean}
  | {type: 'equip'; hero_instance_id: string; weapon_instance_id: string}
  | {type: 'unequip'; weapon_instance_id: string}
  | {type: 'set_target'; target_instance_id: string | null};
```

For example, an interface can connect a card click directly to this handler:

```javascript
import {updateBattleDraft, previewBattleTeam, buildSubmitBattleTeamCommand}
  from '/engine/engine.js';

let {context, draft} = preparation; // one server projection for this game_version

function onTeamAction(action) {
  draft = updateBattleDraft(context, draft, action);
  const preview = previewBattleTeam(context, draft);
  renderTeam(draft, preview);
}

// onTeamAction({type: 'set_hero', instance_id: militiaId, selected: true});
// onTeamAction({type: 'equip', hero_instance_id: militiaId, weapon_instance_id: daggerId});
const command = buildSubmitBattleTeamCommand(context, draft);
// Send this command once when the player confirms the team.
```

Without a target, preview uses rank 0 to display raw team values and returns
`rank`, `health` and `outcome_before_battle_effects` as `null`. With a target, it
applies that hall's rank, darkness and continuous monster restrictions. Outcomes
are provisional: random effects, equipment triggers, choices and monster battle
effects have not been executed. `equipment_events_pending` counts new equip events.
`battle_effects_pending` conservatively flags remaining pre-outcome triggers from
the target, participating hand cards, public halls/settings, or scheduled effects.
It does not execute those effects or inspect random draws. Conditional triggers
that may affect combat are also flagged until resolved. A static DSL analysis
treats `mark_destroy` and disease gains into discard, including nested select/if/sequence/iteration/binding branches,
as outcome-neutral: marked cards and their equipment still contribute until
post-battle destruction, and newly gained diseases do not enter the battle hand.
Disease redirection or destruction replacement does not alter that conclusion;
the gain/replacement still executes normally after confirmation. A sequence that also
draws cards or modifies battle participants/numbers remains uncertain.
Immediate destroy/discard, exclusion, stat changes and
unknown operations remain conservative. The declaration UI uses a third question-mark
status with “有效果待执行” instead of predicting victory or defeat in that case.
Clicking a hall target only changes the local draft. “确认战斗” sends the separate
`DeclareBattleTarget` command. Base team values remain visible, with parenthesized
target-adjusted values; these exclude unexecuted triggers and the combined total
also accounts for darkness. New authoritative snapshots invalidate stale targets.

`turnOptions.card_statuses` is an internal instance-keyed read model. Per-card
modifier applications retain public source card identity and signed values;
active protection buffs and deferred destruction flags supply additional marks.
These records are display evidence, never calculation inputs. Participant views
attach `statuses` only to visible card records and omit hidden-hand statuses.
Each status has `kind` (`buff`, `debuff`, `destroy`), `source_name`, `description`
and optional `source_card_id`. Numeric/deferred statuses expire with the battle
context or their actual flags; destruction protection follows its turn duration.
Valid disease attack-pool choices are retained; if changing the team makes a chosen
pool invalid, the shared default allocation is used in both preview and submission.

## Submission and effect semantics

### Local preparation and synchronization

Ordinary equip/unequip and participation toggles stay in the browser draft. They
update the shared preview and animation immediately, with no command per click.
`options.immediate_equipment_instance_ids` identifies weapons whose equip event
could trigger an effect; those still issue `EquipWeapon` immediately. The engine
derives the hint from reviewed, registered and scheduled `CARD_EQUIPPED` triggers,
conservatively treating non-source-specific listeners as requiring resolution.
Clients missing the hint retain immediate submission for compatibility.

Entering ability mode flushes changed equipment once through
`UpdatePreparationEquipment {equipment}` to refresh equipment-dependent ability
legality. `ActivateAbility`, `EquipWeapon`, `AssignDiseasePenalty` and
`AssignStrengthPenalty` can also carry optional `preparation_equipment`. The engine
validates/applies that mapping before executing the command in the same transition.
New triggered pairs cannot be introduced through this field; they must use the
normal equipment event workflow. Unequipping never removes already-earned buffs.
Synchronization does not commit participation or consume spells.

While these preparation requests are pending, hero/support contribution choices
remain editable locally; final team submission and effect choices still wait for
authority. Replies preserve local contribution choices, reconcile equipment from
the accepted state, and reject invalid optimistic triggered-equipment display.
The client pauses versioned realtime refreshes during commands: if the response
already covers the notified version, it does not fetch that snapshot again.
Reconnect/profile notifications still refresh even at the same match version.

The command shape is `{type: 'SubmitBattleTeam', player_id, expected_version, draft}`.
The server checks actor, phase, pending choices, all draft revisions, current hand
membership, duplicate IDs and weapon capacity/weight. Submission has no target:
`draft.target_instance_id` must be `null`; the command builder clears any local
preview target. Target restrictions are checked during declaration.
An empty hero selection is legal. The server calculates all values again.

Equipment can be assigned to any legal current-hand hero, including a hero not
selected for battle. Deselecting a hero retains its equipment. Strength, weapon
weight and capacity remain validated; attack, magic attack and light from the
hero and its weapons contribute only while that hero participates. Preparation
also accepts `{type: 'UnequipWeapon', player_id, expected_version, instance_id}`;
its legal instances are advertised separately. It removes the authoritative
equipment pair without undoing effects that already resolved on equipping.

New equipment emits the existing `CARD_EQUIPPED` events, resolving each pair's
effects before equipping the next pair. Choices interrupt the
serializable workflow normally; resolving them continues the same submission.
If these effects change the hand or drop selected equipment,
the engine emits `battle_team_revision_required` and returns to
preparation. Request a fresh context and confirm the revised team. Already equipped
weapons do not trigger again on the next submission.

Otherwise the engine records `battle_context.battle_team`, emits
`battle_team_submitted` and records the selected spells as used. Mandatory plague
and fatigue effects resolve at `BATTLE_TEAM_COMMITTED`. Their choices suspend in
`BATTLE_COMMIT` as part of stage 2; clients must resolve them before continuing.
Hero strength, total weapon weight and zero-strength destruction marks are reconciled.
Zero-strength marks use the ordinary after-battle destruction window: they do
not remove contribution before the outcome, and resolve before the monster
departs. Prevention/replacement and repeated reconciliation do not create a
second attempt for the same zero-strength hero in this battle.
The engine then pauses at `DUNGEON_DECLARE` (stage 3), without choosing or attacking
any monster. Only `{type: 'DeclareBattleTarget', player_id, expected_version,
target_instance_id}` chooses the hall monster/rank and starts battle resolution.
The legal command advertises current target instances. `ReviseBattleTeam` returns
to preparation if the player needs to adjust the team; it preserves already resolved
effects, spell use and once-only commitment penalties.
The selection lasts through this battle and is cleared with the turn context.

`previewBattleTeam.continuous_card_statuses` returns instance-keyed, source-labeled
continuous effects derived from the draft, for both hand cards and public hall/environment cards.
Conditional combat bonuses record evidence in the same branches that calculate their numbers;
equipment capacity, conversions, immunity and economy rules also expose source-labeled descriptions.
Team-wide changes identify their scope instead of pretending each hero individually receives the total.
Status entries have `continuous: true`;
the browser replaces previous continuous entries while retaining explicit
temporary buffs, debuffs and destruction marks. `turnOptions.card_statuses`
includes the authoritative equivalent after the team is committed. The preview
never writes these derived entries into permanent card values or match state.

`turnOptions.public_effects` contains source-labeled statuses for all-player light
effects such as Guiding Light. They appear beside the player-list heading, never
on individual hand cards. Display text omits duration; the engine still expires
each effect at its caster's next turn end. Battle preview and authoritative
calculation add each global bonus once, even with an empty team, independently
of participating cards' printed light. Changing team membership does not multiply
the bonus.

During preparation, selecting or deselecting a spell only changes the local draft:
it sends no command and never marks a spell as used. `ActivateAbility` records actual
ability use; `SubmitBattleTeam` records selected spells after validating the team.
The standalone `UseSpell` command has been removed. Bluefire
Staff can recast a spell only after an authoritative use. Recasting repeats its
printed/dynamic numerical contribution and applicable dungeon abilities, with normal
interruptible choices. Unselected spells still contribute no battle numbers.
Cancelling a preview leaves an otherwise unused spell unused; it cannot undo an
already activated ability or a previously committed use.

Selection has these rules:

- Unselected heroes contribute none of their printed attack, magic attack, light
  or continuous combat auras, and do not trigger their own battle/victory abilities.
- Dungeon abilities remain usable before submission. Completed moves, draws and
  global dungeon modifiers remain resolved; source-specific restrictions still apply.
- A monster effect that targets hand heroes can still choose a benched hero.
  DSL `participating` filters use the team plus forced combat exclusions.
- Explicit hand conditions still inspect the whole hand. For example, the
  `half_no_element` restriction sees a benched elemental hero. In-play hero limits
  use the participating hero count. The approved Magehunter exception checks
  effective magic attack from participating cards, despite its unchanged hand wording.
- Mandatory diseases and negative hand trophies still apply. A card effect that
  prohibits participation cannot be overridden by selecting that card.
- Selecting passive spell/item support counts as use for category-based monster
  restrictions. Earlier active spell/item use is retained even if its source is
  later deselected; active-ability history remains separate from team selection.

Unversioned `DeclareBattleTarget` calls from preparation remain supported only for
legacy effect-lab/migration fixtures and use the old all-hand calculation. Versioned
network commands cannot use that shortcut: submit the team, then declare the target.

## Python and local HTTP adapters

Python callers use:

```python
from backend.app.integrations.game_engine.api import (
    battle_preparation, submit_battle_team,
)

preparation = battle_preparation(server_state, active_player_id, snapshot=catalog)
result = submit_battle_team(server_state, command, snapshot=catalog)
# The room layer persists result['state'] and publishes player-specific views.
```

The current local prototype also exposes these routes:

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/v1/battle/context` | `{state, player_id}` | `{status: 'ready', context, options, draft}` |
| `POST /api/v1/battle/submit` | `{state, command}` | `{status: 'ready', state, events, legal_commands}` |

These stateless routes follow the existing local setup sandbox and accept a full
state for development. They do not store a room or authenticate ownership of an
uploaded state. A multiplayer room handler must load its server-owned state and
derive the actor from room membership before calling the Python adapter; it sends
only the visible preparation result and player-specific state/events to clients.

The formal multiplayer implementation now follows this boundary through
`POST /api/v1/matches/{id}/commands`. Its envelope carries `MatchView.version`
and an idempotency `command_id`; its `SubmitBattleTeam` intent carries only the
three editable team fields in `draft`, plus an optional `target_instance_id: null`.
The service injects the frozen rule
revisions, authenticated player and current engine `game_version`. See the
[match API](../match-lifecycle.md) for the transport contract. The endpoint accepts
`DeclareBattleTarget` only in the declaration phase and also accepts `ReviseBattleTeam`.

Invalid JSON returns 400; invalid commands, actor/phase/revision conflicts or
malformed selections return 422; an unavailable worker/build returns 503.

## Verification

`engine/tests/battle-team.test.mjs` covers local click updates, immutable
Node/browser parity, hidden-zone projection, the benched-mage decision, spell-only
combat, mandatory negative cards, hand versus participant scope, source abilities,
equipment validation, version/actor rejection, and equipment-trigger interruption.
`backend/tests/api/test_battle_team_api.py` checks Python and HTTP contracts and error paths.
