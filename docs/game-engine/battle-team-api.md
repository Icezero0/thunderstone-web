# Battle team API

## State and ownership

The backend owns `GameState`. During uninterrupted `DUNGEON_PREPARE`, it calls
`battlePreparation(state, playerId, catalog, ruleset)` and sends the returned
`{context, options, draft}` to the active player. The context contains that player's
hand, public halls, relevant card definitions and calculation rules. It excludes
draw piles, opponents' hands, RNG, private flags and effect continuations.

The frontend edits `BattleDraft` locally. Each click calls `updateBattleDraft` and
`previewBattleTeam` from the same `@thunderstone/engine` package used on the server.
These functions do not change the match, consume RNG, execute abilities or send
requests. Defaults select all hand heroes and optional support, retaining current
equipment; a client can start with empty selections if desired.

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
selected in `support_instance_ids` and need no hero. Equipment belongs to a selected
hero; removing that hero also removes its draft equipment. Diseases, monster hand
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
Valid disease attack-pool choices are retained; if changing the team makes a chosen
pool invalid, the shared default allocation is used in both preview and submission.

## Submission and effect semantics

The command shape is `{type: 'SubmitBattleTeam', player_id, expected_version, draft}`.
The server checks actor, phase, pending choices, all draft revisions, current hand
membership, duplicate IDs, weapon capacity/weight and the visible attack target.
An empty hero selection is legal. The server calculates all values again.

New equipment emits the existing `CARD_EQUIPPED` events, resolving each pair's
effects before equipping the next pair. Choices interrupt the
serializable workflow normally; resolving them continues the same submission.
If these effects change the hand, drop selected equipment or make the target
unattackable, the engine emits `battle_team_revision_required` and returns to
preparation. Request a fresh context and confirm the revised team. Already equipped
weapons do not trigger again on the next submission.

Otherwise the engine records `battle_context.battle_team`, emits
`battle_team_submitted` and records the selected spells as used. Mandatory plague
and fatigue effects then resolve at `BATTLE_TEAM_COMMITTED` before monster battle
effects. Their choices suspend in `BATTLE_COMMIT`; clients must resolve them before
any other action. Hero strength, total weapon weight and zero-strength destruction
marks are reconciled after these effects. The engine then declares the target and
runs the usual battle workflow.
The selection lasts through this battle and is cleared with the turn context.

During preparation, `{type: 'UseSpell', player_id, expected_version, instance_id}`
explicitly records a spell's first use without automatically activating its optional
abilities. `legal_commands` supplies `UseSpell.instance_ids`. Activating a spell
ability also records use. Local preview alone never marks a spell as used; Bluefire
Staff can recast a spell only after an authoritative use. Recasting repeats its
printed/dynamic numerical contribution and applicable dungeon abilities, with normal
interruptible choices. Unselected spells still contribute no battle numbers.

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

Legacy `DeclareBattleTarget` remains accepted for existing replays and implicitly
uses the old all-hand calculation. New clients should submit `SubmitBattleTeam`.
The migration parity gate ignores only the newly advertised command when comparing
legacy responses; the new selection behavior has independent browser/server tests.

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
four editable selection fields in `draft`. The service injects the frozen rule
revisions, authenticated player and current engine `game_version`. See the
[match API](../match-lifecycle.md) for the transport contract. The legacy
`DeclareBattleTarget` command is not exposed by this authenticated endpoint.

Invalid JSON returns 400; invalid commands, actor/phase/revision conflicts or
malformed selections return 422; an unavailable worker/build returns 503.

## Verification

`engine/tests/battle-team.test.mjs` covers local click updates, immutable
Node/browser parity, hidden-zone projection, the benched-mage decision, spell-only
combat, mandatory negative cards, hand versus participant scope, source abilities,
equipment validation, version/actor rejection, and equipment-trigger interruption.
`backend/tests/api/test_battle_team_api.py` checks Python and HTTP contracts and error paths.
