# Disease gains and sequential traps

## Disease replacement

The game owner confirmed these rules on 2026-10-25:

- Sidhe redirection is optional, including a two-player game with only one legal recipient. The receiver selects a highlighted player row or skips to receive the disease themselves.
- Plague Breaker still destroys diseases automatically. Skipping optional redirection cannot bypass mandatory removal. Several identical destroy replacements resolve once without an ordering prompt.
- When distinct replacements are available, the receiver chooses the source first. Each source instance can replace a particular gain at most once, so redirection between Sidhe players terminates.
- An explicit hand/draw destination is retained when redirection is declined. Actual redirection sends the disease to the chosen player's discard pile.

Optional redirection is a game adaptation. Original card text and artwork are preserved.

The engine keeps the same instance in `pending:disease` while waiting. `DiseaseGain.gain_id` identifies the gain independently of the persistent instance ID and survives source and recipient responses. Events are `disease_gain_started`, `disease_gain_completed`, `disease_redirected`, and `disease_gain_destroyed`. Card IDs are recorded before a destroyed disease is deleted from the instance registry.

The participant projection exposes public card IDs, players, destination categories and `gain_id`, excluding private instance identities, used-source lists, RNG samples and interpreter frames. Public `pending_disease` contains only `{gain_id, card_id, player_id}`. Actionable choices remain exclusive to the receiver.

For a monster-originated gain, the start event can include `source_card_id`,
`source_hall_zone` and `source_rank`. The engine captures this public position from
the actual DSL source (including a global hall source or rank-zero guardian),
not simply the battle target. Internal source instance IDs are not projected.
When that same monster is still visible in the active dungeon viewport, the
frontend generates the disease on its card, flies it to screen center and pauses
there before delivery. An offscreen, absent or mismatched source, or the village
tab being active, falls back to center generation. It holds through responses,
then flies to the receiver's discard pile or is destroyed. Explicit destinations
are honored. Reconnection restores the pending card without replaying generation.
Player rows expose legal recipients in selection mode; clicking them submits the
choice instead of opening the browser. Skip is a response-bar action.

## Trap resolution

Dungeon refill resolves one revealed card at a time. A drawn trap enters its actual hall rank and pauses with `pending_choice.kind = trap_activation`. Only the active player can submit `ResolveTrap` with that instance ID. This explicit activation is never automatically selected even when it is the only clickable card. Other commands, wrong instances and stale revisions are rejected. The existing delayed-trap environment still waits until rank 1 before offering activation.

The trap schedules its event, disposal, then the next refill. Clicking it starts the effect; choices and responses inside its effects suspend that queue while the trap remains in the hall. Another trap cannot be drawn until the current one has fully resolved and left. The same state survives persistence/reconnection without replaying effects.

Printed lines of the same `TRAP_REVEALED` source execute in ability-number order without a simultaneous-effect ordering prompt. Independent effects from different sources retain existing ordering rules. Dragon Tongue's own-player and other-player clauses finish before another trap is revealed.

The match event timeline flies a trap from the dungeon deck into its hall slot,
without a central spotlight. The hall card glows for the authorized actor;
clicking it submits `ResolveTrap`. When another public tab is active, the
dungeon tab indicates the pending response. Reconnect uses the ordinary public
hall snapshot, so no separate `pending_trap` projection is needed.

After every effect and response finishes, the engine moves the trap to the
removed (`destroyed`) zone, retaining compatibility with effects that shuffle
used traps back. It emits `card_destroyed` with `cause: trap_resolved`, followed
by the semantic `trap_removed` event (public card, hall and rank, no historical
instance ID). The timeline handles removal once, at `trap_removed`: the trap
desaturates, sinks slightly and fades at its own slot before any refill. Its
low-level destruction event does not trigger a second animation. Other cards
destroyed by the trap still use their actual destruction events and animations.
Other public destruction causes are `after_battle`,
`hero_upgrade`, `disease_gain` and `effect`; raw interpreter reason strings
remain private. Evolution and disease removal own their semantic animation;
their accompanying low-level destruction event does not replay it a second time.

The `defeated_monster` query excludes instances already in the destroyed zone. A second Dragon Tongue cannot destroy the same defeated monster twice. For a monster just gained into discard, the frontend shows receipt first, then moves it from discard to center and destroys it before showing the next dungeon card.

Regression coverage: `engine/tests/trap-sequence.test.mjs`, `disease-responses.test.mjs`, `frontend/tests/match-page.test.mjs`, and backend participant-projection tests. Builds and DOM tests do not perform visual acceptance checks.
