# Effect runtime verification lab

This temporary local page exercises the executable JSON effect interpreter through the public setup and turn APIs. It is a developer probe, not a playable match client. Each request creates a fresh deterministic game in memory, applies an explicitly described fixture, submits commands, and returns a step trace. No trace or game state is stored in SQLite.

## Open the page

From the project root, start the existing local preview yourself:

```powershell
.\.venv\Scripts\python.exe scripts\run_config_panel.py --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765/effect-lab`. Select a case, move through the timeline, and inspect the command, state before and after, actual DSL node path, emitted events, available next commands, assertions, and compiled JSON ability. Supported replay choices have clickable candidates; other pending choices show the recorded scripted candidates without pretending that a click can alter that step. The page marks synthetic DSL examples separately from reviewed card abilities. The expandable coverage manifest lists all 520 effect cards, searchable by name, ID and type, with covered ability IDs and per-card unit-test names. This manifest reads the generated audit report; it does not start a test process.

## Case matrix

| Case | Source | Main contract |
| --- | --- | --- |
| `hero-copy` | Reviewed `TS-0415`, `TS-0428` | Militia retains its attributes, replaces attack, uses a copied active ability, and leaves the original hero independently usable. |
| `borrowed-weapon` | Reviewed `TS-0327`, `TS-0459` | Borrow/equip an opponent's weapon; its battle destruction prevents later return. |
| `trap-immunity` | Reviewed `TS-0536`, `TS-0691` | Only Bandit's holder is protected; the active player's hero is still destroyed and the interrupted ability resumes. |
| `spell-reuse` | Reviewed `TS-0244`, `TS-0267` | Equip a caster, explicitly choose an already-used spell ability, execute it again and destroy the spell at turn end. |
| `attached-disease` | Reviewed `TS-0422`, `TS-0239` | Move a disease beneath a monster; before combat, gain the same instance and apply Plague Breaker's replacement. |
| `extra-turn` | Reviewed `TS-0696` | Sacrifice the treasure after a low-VP defeat, take the extra turn, then resume normal rotation. |
| `deferred-destruction` | Reviewed `TS-0295`, `TS-0486` | Protected heroes still fight; after combat the selected hero is discarded instead of destroyed, and the buff expires at turn end. |
| `destroy-cost-replacement` | Reviewed `TS-0247`, `TS-0471` | Guardian Blade replaces an immediate destruction cost with discard, still allowing victory. Declining after declaring combat loses the battle, sends the monster to the dungeon bottom, refills the hall, and awards neither the monster nor XP. Three refill monsters keep the retreated monster from being drawn straight back in this fixture. |
| `doomheart-loss` | Reviewed `TS-0683`, `TS-0199` | A failed attacker is eliminated; the survivor keeps taking turns and the match does not settle. |
| `doomheart-win` | Reviewed `TS-0683` | Each held stone gains +6 magic attack; defeating the Heart immediately scores the acquired guardian. |
| `xp-choice` | Reviewed `TS-0273-A02` | Choose 0–5 XP, reject an out-of-range payment, and resume with an equal magic attack bonus. |
| `deck-reorder` | Reviewed `TS-0453-A02` | Reveal three dungeon cards, reject duplicate IDs, then return the chosen ordering without altering the fourth card. |
| `trophy-versus-battle` | Reviewed `TS-0582` | Two hand trophies give magic attack +2; the target in the hall gives no hand attack and triggers disease once. |
| `refill-trap-resume` | Reviewed `TS-0268`, `TS-0688` | Returning a monster reveals a trap; the trap choice finishes before the original ability requests its destruction cost and draws. |
| `disease-choice` | Reviewed `TS-0428-A02` | Two legal disease targets pause execution; chosen disease is removed; draw two; activation is once per turn. |
| `monster-count` | Reviewed `TS-0428-A03` | Query counts monster cards in hand and evaluates `2 × count` before drawing. |
| `thornwood-tie` | Reviewed `TS-0193-A02` | Action-exit trigger selects among tied maximum-price village supply tops; cleanup waits for the choice. |
| `thornwood-unique` | Reviewed `TS-0193-A02` | A single maximum-price candidate resolves automatically and the turn passes. |
| `condition-schedule` | Synthetic JSON | Conditions, branch, card loop, bounded repeat, and `TURN_WILL_END` scheduling. |
| `condition-false` | Synthetic JSON | False `any` condition prevents activation; a second ability enters `else` and evaluates addition. |
| `cost-rollback` | Synthetic JSON | An unaffordable XP cost rejects the complete command without changing its input state. |
| `cost-gain-discard` | Synthetic JSON | Pay XP, gain a basic card, pause for dagger selection, and discard the chosen card. |
| `battle-modifiers` | Synthetic JSON | Attack and light modifiers reach the battle calculation trace. |

The synthetic abilities use `TS-0001` as a source solely to drive the interpreter. They are not entries in the reviewed effect JSON and do not claim that militia has these powers. The 23 lab examples illustrate selected behaviors. The state view includes hero protection, pending destruction, copied abilities, borrowed ownership, attachments, cross-turn rules, listeners, all players' fixture hands/discards, eliminated players, settlement results, and the first five dungeon cards as explicit developer-only data. This page is not a private multiplayer client. Complete per-card verification is tracked in `data/effects/card-coverage.csv` and `tests/test_card_effects.py`.

The runner lives in `devtools/effect_lab.py`, the page in `web/effect_lab.*`, and the read-only preview routes in `backend/app/api/resources.py`. Each trace includes its fixed seed, rule version, input command sequence, state projections, actual interpreter decisions, engine events, and explicit checks. `apply_command(..., trace_effects=True)` returns these debug decisions as `effect_trace`; they do not enter game state or the authoritative event log. Unit tests in `tests/test_effect_lab.py` run every case, alternative choices, rollback behavior, and the HTTP preview routes without starting a server.

```powershell
.\.venv\Scripts\python.exe -m unittest tests.test_effect_lab -v
```
