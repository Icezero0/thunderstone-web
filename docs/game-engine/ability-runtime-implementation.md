# Executable ability runtime

## Sources and release boundary

`docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json` is a decomposition draft of 964 ability lines. The engine does not execute its generic AST. The reviewed `classic-v1.json`, `simple-reviewed.json`, `action-reviewed.json`, `battle-reviewed.json` and `event-reviewed.json` contain 446 fully bound abilities. `mechanics.json` contains 222 continuous rule and replacement bindings. Each binding names an ability ID, card source and its applicable zone or rule hook. Offline generators check the exact source line against the catalog. Runtime dispatch uses these bindings rather than parsing arbitrary Chinese text.

The JSON has no embedded Python. Compilation rejects unknown keys, unknown operations, unsupported expressions, invalid source IDs, duplicate IDs, unbounded loops and missing bindings. The runtime receives the same `CatalogSnapshot` as setup/turn code; it does not open SQLite. It uses the game state's event, instance and RNG sequences, and one command either returns a complete new state or raises without changing its input.

## Executable JSON shape

```json
{
  "schema_version": "thunderstone.effects/1",
  "abilities": [
    {
      "id": "TS-0428-A02",
      "source_card_id": "TS-0428",
      "kind": "activated",
      "actions": ["village", "dungeon"],
      "source_zone": "active_hand",
      "usage": "once_per_turn",
      "conditions": [],
      "body": {
        "op": "select", "query": {"zone": "active_hand", "card_type": "疾病牌"},
        "bind": "disease", "min": 1, "max": 1,
        "then": {"op": "cost_gate",
          "cost": {"op": "destroy", "target": {"var": "disease"}},
          "then": {"op": "draw", "count": 2}}
      }
    }
  ]
}
```

An activated ability is submitted as `ActivateAbility` with `source_instance_id` and `ability_id`. Activated sources can be in `active_hand` or `active_control` (treasures). Trigger sources can also be `settings`, `battle_target`, `hall` or `event_source`. This is essential for monsters: an ordinary hand attack/light line does not apply from the hall; a battle ability does not trigger from another copy held as a trophy. Source identity is checked again when a pending choice resumes.

## Typed parts

| Part | First implementation | Later extension boundary |
| --- | --- | --- |
| Expressions | bounded integers and arithmetic; count/sum/maximum; card stats; resources; bound values; typed event rank/price | expressions and nested queries require in-scope variables |
| Conditions | `all`, `any`, `not`, `compare`, `exists`, `action_in`, `setting_active` | no evaluation of free text |
| Queries | active/subject hand and discard; controlled treasures; supply tops; bound reveals; hall/rank; event source; just-defeated monster; typed filters and extrema | hero identity uses only the explicit 英雄 tag on hero, village and basic cards; no category fallback |
| Flow | sequence, condition, optional/multiple selection, cost, per-card/per-player loops, bounded repeat, numeric and card-set bindings, reveal, draw-and-bind, scheduling, effect purchase and upgrade, value selection and card ordering | choices serialize frames; per-player effects select the correct responding player |
| Atoms/hooks | resources, disease replacement, card movement/destruction, per-card modifiers, turn buffs, deferred battle destruction, supply destruction/replenishment, hall changes, reveal cycles, next-hand bonus, retreat and elimination, copying, borrowing, responses, attachments, extra turns | domain hooks remain explicit, typed Python operations; no free-form evaluation |

The interpreter executes depth-first. A `select` with one legal candidate binds automatically; with several candidates it stores `pending_choice` and serializable continuation frames. `ResolveChoice` must come from the named player, choose current candidates and satisfy count bounds. Other commands are rejected while a choice is pending. A failed `cost_gate` never runs its benefit. `source` is a reserved binding for the ability's own instance. Abilities can be once per turn or repeatable; the once per turn limit is stored per source instance and ability and reset during turn cleanup. The canonical JSON hash is stored as `GameState.effects_version`; a changed ruleset cannot silently continue an old state.

`schedule` supports `TURN_WILL_END`, `BATTLE_AFTER_OUTCOME`, `HAND_REFILL_COMPLETE` and the same player's next `TURN_START`. An opponent's turn does not consume the schedule. Reviewed battle lines resolve in their card order. Other simultaneous triggers can request `ResolveEffectOrder`; the selected order must contain each offered effect once. `ResolveChoice` accepts `instance_ids` for multiple/optional selections. `ResolveEffectPurchase` selects an affordable offered card or skips the purchase.

`choose_value` offers a bounded number, an eligible player, a declared enum value, or one dungeon. `ResolveValueChoice` must return an offered value of the exact type: `true` cannot stand in for `1`. `reorder` uses `ResolveCardOrder` and requires a permutation of every current candidate. Dungeon reveals remain in a temporary unowned zone until the chosen ordering returns them to their original deck; another dungeon stays untouched. `remember` captures a card set in the continuation, allowing effects such as Quartermaster and Tax Collector to distinguish newly drawn/discarded cards from cards already present.

Selections can use bounded expressions for their counts, keep the highest values, or cap the number matching one filter. Titan therefore requires the two strongest heroes, including an appropriate choice among ties; Basilisk permits at most one hero and falls short only when there are not enough eligible cards. Spectral monster payments are explicit optional decisions, and declining leaves `cannot_defeat` set regardless of attack total. Battle destruction normally stays deferred; the Spectral cards explicitly require immediate payment.

Once combat has been declared, declining or being unable to pay a Spectral cost is a battle loss. The ordinary failed-battle departure still applies: the monster returns to the dungeon bottom, the hall refills, and the player gains neither the monster nor defeat XP. `cannot_defeat` restricts the player's victory; it does not make the monster immovable. The lab supplies follow-up dungeon cards so the retreated monster is not immediately redrawn from an otherwise empty test deck.

`upgrade` offers the same legal levels, series, XP costs and inventory as a village upgrade. `ResolveEffectUpgrade` chooses a source/target pair or skips. It returns the new hero to the specified zone and pays a treasure cost only after a valid upgrade. A hero gained by upgrading is marked with `upgraded_on_turn` so it cannot be levelled again that turn. Upgrade timing and source identity survive JSON restoration.

## Initial verified bindings

| Ability | Binding | Test focus |
| --- | --- | --- |
| `TS-0428-A02` | choose and destroy one disease in the active hand as cost, then draw two; village or dungeon | no disease, several diseases, pending choice and replay |
| `TS-0428-A03` | draw twice the number of monster cards currently in hand | zero, one and multiple monsters; no fixed `2` shortcut |
| `TS-0193-A02` | after village or rest, destroy the highest priced nonempty village supply top; active player breaks a tie | empty supply, unique maximum, tie, source setting inactive |

The second reviewed JSON adds exact draw, XP, extra purchase, self destruction for gold, disease destruction for draw, militia destruction for XP, and temporary attack/magic attack abilities. Separately, the combat baseline reads exact unconditional attack/magic attack/light lines when the corresponding structured field is blank. Target rules cover immunity to magic attack and magic attack only. Battle rules give one disease when a monster with the exact printed line is fought; the current weighted disease supply determines its card ID. Environment rules cover the printed light penalties for `TS-0193` and `TS-0194`. These direct rules have one frozen source line contract per card.

Continuous combat rules recalculate rank, equipment, strength, hand conditions, hall auras, light and target restrictions. Ordinary rank 1/2/3 requires 1/2/3 light; every missing light costs 2 attack. Thornwood Forest requires 1 light at ordinary ranks, while rank 0 stays exempt. Disease attack penalties apply to one positive attack type, with `AssignDiseasePenalty` allowing an explicit allocation. Fatigue affects one hero; `AssignStrengthPenalty` changes that allocation. Zero strength reached in battle creates one sticky turn-end destruction mark, even if strength later recovers.

The generated [ability report](../../data/effects/coverage.csv) and [card report](../../data/effects/card-coverage.csv) track coverage. As of 2026-10-21: 446 `READY`, 222 `MECHANIC_READY`, 215 `PRINTED_BASELINE`, 19 `TARGET_RULE`, 6 `SETUP_READY`, 2 `ENV_RULE`, 38 `SYSTEM_RULE`, 16 `RULE_REFERENCE`. All 520 effect cards are `COMPLETE`; there are no draft or partially covered cards. The reference card's 16 instruction lines are documentation, outside the 520 playable effect cards. Treefolk expand and refill both the initial hall and the hall during play; setup and runtime share the capacity calculation. This is line-and-behavior coverage for the current catalog and confirmed classic rulings, not exhaustive proof of every possible card combination.

Verify generated files with `--check` on `build_simple_effects.py`, `build_action_effects.py`, `build_battle_effects.py`, `build_event_effects.py` and `build_mechanics.py`. Regenerate reports with `scripts/audit_effects.py --output data/effects/coverage.csv --card-output data/effects/card-coverage.csv --require-complete`. The completeness gate fails if any card is unfinished.

`tests/test_card_effects.py` creates a stable `test_effect_TS_XXXX` entry for every one of the 520 effect cards. Every card entry executes its reviewed behaviors, with separate card ID named tests for the underlying printed, activated, target, battle, setup, event, mechanic and system contracts. The manifest checks exact card lines and requires all cards to be complete. An incomplete card fails the suite rather than being skipped. A card is complete only when **every** decomposed ability line is covered. Cross-card public-command tests also check timing, ownership, authorization, immutable input and JSON continuations.

## Turn integration

`engine/turn/workflow.py` serializes event dispatch, hall refill, effect continuation and turn cleanup. Timings include dungeon/village entry, equipment, purchases, upgrades, battle before/after outcome, monster defeat, hall reveal, breach, traps, hand refill and turn start/end. If refill reveals a trap, the original ability stack stays in the workflow while the trap runs; after its choices complete, the original ability continues. The previous parallel implementations of combat and hall refill were removed.

`engine/effects/purchase.py` gives each spoils offer its own allowance from the current surviving hand, rather than sharing the village gold pool. `engine/scoring.py` handles printed VP and reviewed insect/horde/stone scoring at settlement, excluding eliminated players from winner and fewest-monster comparisons. `engine/turn/settlement.py` centralizes terminal state changes; queued ordinary turn work stops immediately after settlement.

Banishing Ritual permits dungeon turns. Claiming a stone continues play; an unclaimed stone at rank 1 returns to the dungeon bottom. Defeating Heart of Doom ends play and includes the gained guardian in scoring; its breach ends play before it moves to rank 0. A failed attack eliminates only the attacker when its battle effect applies. Remaining players continue; if everyone has been eliminated there is no winner. The Heart's stones gain **+6** magic attack, corrected in the catalog from the English card text with user confirmation on 2026-10-20. Flying Spire continues after its first acquired stone, ends after its second, and also ends if a stone reaches rank 1 without being acquired.

`engine/rules/players.py` supplies the surviving participant list. Turn passage retains the original player order but skips eliminated seats; a round wraps relative to `first_player_id`. Delays for the next own turn are consumed at that player's next actual turn, even if elimination has shortened the rotation. The backend submits commands and persists states; calculations stay independent of network and database code.

## Disease replacement decisions

`engine/effects/disease.py` resolves Plague Breaker and the two Sidhe disease redirects. The receiving player chooses between applicable replacements. A redirect then selects another surviving player, whose own hand can provide a replacement. Per user ruling on 2026-10-20, each source instance may replace the same disease gain only once. The disease is sampled once, retaining its instance and RNG result throughout redirections; Sidhe always redirects to a discard pile. A destroyed disease returns to the infinite supply by removing its instance.

Pending arbitration uses `ResolveDiseaseReplacement` with either `source_instance_id` or `recipient_id`, according to its recorded stage. The disease waits in an unowned pending zone. Batch disease effects create one disease, finish its replacement chain, then create the next and resume the original ability. The public `engine.disease.take_disease` uses this same transition; it can return a pending choice, and its `instance` is `None` after an automatic destruction. Tests in `test_disease_replacements.py` exercise recipient authorization, conflict choice, JSON restoration, loops and batch interruption.

## Destruction timing and turn protection

Per user rulings on 2026-10-20, ordinary battle destruction uses `mark_destroy` and resolves after the combat outcome is calculated. An explicit immediate destruction or destruction cost uses `destroy` immediately. If destruction is replaced by discarding, the cost is still paid and its benefit continues; the discarded hero no longer contributes to the subsequent combat calculation.

`grant_turn_buff` binds `discard_instead_of_destroy` to one hero instance. `flags.turn_buffs` records the ability, source instance and `expires_after_turn`. Guardian Blade (`TS-0247-A02`) grants this buff to the `event_hero` on `CARD_EQUIPPED`; Feast and Ambrosia (`TS-0295-A01`, `TS-0296-A01`) grant it alongside their strength and attack bonuses to the heroes in hand when activated. The buff survives leaving hand, losing the weapon or removing its source, and is not consumed by a replacement. It applies to immediate costs, deferred battle destruction and turn-end destruction, including sticky zero-strength marks. It expires only after end effects and hand refill, just before `TURN_ENDED` and turn passage.

`Transition.destroy_card` is the shared replacement boundary. Replacement keeps the hero's owner and emits `card_destruction_replaced`, not `card_destroyed`. A fulfilled destruction clears its pending destruction marks so they cannot fire in a later battle. Turn-end marks follow the instance even if another effect has already discarded it. Buffs belong to instances; upgrading creates a new instance without inheriting the old hero's buff. Tests in `test_destruction_replacements.py` cover timing, explicit payments, upgrades, simultaneous weapon/hero removal, repeated replacement, JSON restoration and expiry.

## Advanced runtime modules

| Module | Responsibility |
| --- | --- |
| `responses.py` | Per-recipient trap/battle/opponent response windows and optional hero destruction prevention |
| `abilities.py` | Source identity for copied abilities; copying and explicit spell reuse |
| `borrowing.py` | Temporary ownership and return obligations on the same instance |
| `attachments.py` | Caged heroes, Emerald/Sapphire pairs and diseases beneath monsters |
| `durations.py` | Cross-turn light and forced-dungeon rules with explicit expiry |
| `inventory.py` | Supply destruction, Regian return replacement, Stormhold replenishment |
| `hall_actions.py` | Adjacent swaps, held/revealed monster exchange, shuffle-with-top and trap reshuffle |
| `rules/reserves.py` | Shared Horde/Swarm reserve marker rules for setup and runtime |

The interpreter composes these domain operations into the same serializable workflow. `listen` registers an event/body/condition with its captured bindings and current turn; a one-shot listener is consumed only when its conditions match. `remove_listener` can consume a listener after an optional successful gain. `collect` builds an explicit set across players for a later global selection. `BEFORE_HALL_REFILL` runs before filling vacancies, allowing Broadsword to claim a remaining low-VP monster without defeat XP.

### Responses and affected-player scope

`ResolveResponse` accepts an offered `source_instance_id`, or neither argument to decline at the source stage. Veteran then requests a `recipient_id`; choosing a recipient is mandatory after committing to that redirect. Only the pending player can answer. The original compiled stack and workflow remain paused throughout, including after JSON restoration. Source identity is revalidated on resume.

Per user confirmation, immunity and redirect change only the responding player's portion. Other players' original portions still execute. If two portions are redirected to one player, that player can receive both. A trap's immunity/redirect decision is keyed by its physical instance and covers all of its printed trap lines; a once-per-turn Bandit therefore does not spend its immunity separately for each line. These records are cleared when the trap is disposed. Elixir/Bandit protect their holder, Veteran redirects the active player's trap portion, Bishop redirects an actual opponent effect targeting its holder, and Ruby cancels one battle effect. Border Guard can prevent a hero's battle destruction by sacrificing itself, but cannot satisfy a destruction cost by preventing that cost.

### Copying, reuse and borrowing

User ruling on 2026-10-21 for `TS-0415-A02`: the selected Militia keeps its printed name, level, strength and tags. It copies the other hero's effect abilities and replaces its original attack with the copied attack; the original hero remains independently usable. The binding is `preserve_attack=false, full_card=false`. The physical instance keeps `card_id=TS-0001`; `copied_heroes` supplies additional ability/mechanic sources and is cleared at turn end. Physical destruction and supply return use `printed_card`, never a copied identity. Choices inside a copied active ability retain this source identity across JSON snapshots.

Bluefire Staff offers `ResolveReusedAbility` with the selected used spell's available dungeon ability IDs. The chosen compiled ability is run again through the normal interpreter, retaining target/cost choices and scheduling that spell for turn-end destruction. The staff must be equipped to an appropriate hero.

Borrowing moves the same card instance into the active player's hand and changes its owner temporarily. `borrowed_cards` records the original owner and return time. Selurin and Toryn return after battle; Lurker returns at turn end. Per user ruling on 2026-10-21, a destroyed borrowed card is **not** resurrected or returned. A discarded card that survived through a destruction replacement still returns. Deferred destruction is settled before the corresponding return step, and settlement resolves surviving return obligations before scoring.

### Attachments, durations and reserves

Attached diseases become unowned beneath a specific monster, then enter the normal disease-gain replacement chain as the same instance before/after its next battle. They are not sampled again. Sidhe's after-battle diseases add health while attached. Cage returns its captive to its original owner after any monster defeat. Emerald can transfer its hidden card after a qualifying defeat; Sapphire restores its pair at settlement before scoring.

Guiding Light lasts through its owner's next turn end; Stalking Spell forces other players into the dungeon until its owner's next turn start. Extra turns consume a player allowance before ordinary turn rotation, increment the turn number and do not advance the round. Registered turn-local triggers and copies still expire at each turn boundary.

Horde/Swarm marker copies go into the dungeon, with increasing-health monster cards kept in ordered reserves. When a marker enters the hall, setup/runtime both replace it with the next reserve card. An exhausted reserve removes the marker and continues filling. Infinite basic supply destruction records the requested action without depleting the supply. Stormhold replenishes emptied hero/village stacks from unused randomizer groups using the injected catalog index and state RNG; the engine never reloads a database during a transition. A transition that is already settling does not replenish supplies.

## Verification commands

```powershell
.\.venv\Scripts\python.exe -X utf8 -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -X utf8 scripts\audit_effects.py --require-complete
```

`tests/test_advanced_effects.py` exercises real card combinations through the public command API with JSON roundtrips between commands. `tests/response_cases.py` supplies the six response-source card contracts. The temporary [effect lab](effect-lab.md) exposes deterministic traces for 23 selected cases and a searchable manifest of all 520 effect cards; the manifest shows binding coverage, while each trace runs its engine assertions live. Multiplayer transport, account integration, private client projections and cooperative/solo variants are outside this effect coverage milestone.
