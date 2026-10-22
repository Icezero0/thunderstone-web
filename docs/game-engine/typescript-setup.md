# TypeScript setup and deterministic random stream

## Boundary

The shared package now validates classic configuration and setup requests,
selects groups/features, creates instances, builds supplies and dungeons, fills
initial halls, deals starter hands, chooses the first player and returns the
complete initial state and private setup events.

Python loads the CSV/SQLite catalog snapshot and reviewed effect version, computes
the existing canonical configuration fingerprint, and calls `startGame(input)`.
Python owns no setup selection or shuffling algorithm. File/database access and
artifact fingerprints remain adapter responsibilities, matching the DSL boundary.

The worker retains no partial match. If allocation is needed, it returns a typed
choice; the caller resubmits the same request/seed with that choice. The existing
setup panel and Python public API keep their request/response contracts.

## Modules

```text
engine/src/
  random/sha256.ts       SHA-256 and strict UTF-8, independent of platform APIs
  random/stream.ts       seeded counter stream, rejection sampling and shuffle
  setup/contracts.ts    request, catalog, state and event contracts
  setup/rules.ts        count adjustments, multipliers and initial supply constants
  setup/validation.ts   ordered configuration issues, request validation and errors
  setup/builder.ts      local setup transaction and optional transaction snapshot
  setup/state.ts        initial instance/owner/hand/hall invariants
backend/app/integrations/game_engine/shared/setup.py  metadata preparation and domain error translation
```

`startGame` is the formal entry point. `SetupBuilder` is an internal transaction
for focused contracts and resumed local steps; it expects validated catalog data.
Its explicit `SetupDraft` can be serialized and restored without a retained worker.
The private Python `_Builder` facade preserves the narrow operations used by
existing per-card tests, submitting each operation with its full draft. It contains
no old selection/shuffle implementation. These partial steps are not HTTP APIs.

## Random-stream compatibility

The algorithm stays `sha256-counter-v1`:

1. Convert the seed to its existing decimal/string representation and SHA-256 its
   UTF-8 bytes to obtain a 32-byte key.
2. Hash the key followed by the current counter as 16 unsigned big-endian bytes.
3. Increment the counter and read the hash as an unsigned 256-bit integer.
4. Reject values beyond the largest multiple of the pool size below 2^256;
   otherwise return the remainder. Shuffling uses the same descending Fisher-Yates
   swaps as before, consuming the same random draws.

The implementation uses `bigint` internally. JSON carries a counter or pool size
as a number when it is safe, or a decimal string otherwise. Python converts the
wire value back to `int`. Large integer seeds are transported as their decimal
strings. This preserves the previous arbitrary-integer seed representation and
counter bytes, including counters above 2^53.

Empty/singleton shuffles consume no draws. A one-candidate pick consumes one.
Resuming from `{seed, counter}` continues the exact same stream. Invalid counters,
empty pools and exhaustion fail explicitly; pools larger than 2^256 are rejected
rather than entering the old algorithm's impossible rejection loop. JavaScript
numeric inputs outside its safe integer range are rejected; pass an exact decimal
string for a large counter or `bigint` for a large pool. No ambient randomness,
clock, Node crypto or browser crypto API is used.

Python's existing `SetupRng` delegates draws/shuffles to this implementation.
Disease sampling, random discards, deck reshuffles and other in-play transitions
also execute in TypeScript; Python retains only compatibility entry points.

## Preserved setup behavior

- Village, hero and monster fixed groups are filled randomly to their targets.
  Each category has one shared instance multiplier; all hero levels share it.
- Classic dungeon feature entries are resolved in the original pool/draw order.
  Manual guardians/environments are cards; manual traps/treasures are groups.
- Environment count adjustments retain fixed and random selection behavior.
  If a random environment lowers a target below already fixed selections, excess
  groups are randomly removed, with the same events and draw counts.
- Flying Spire requires four monster groups, two stones and the player's explicit
  allocation of monster groups and dungeon features to the two dungeons.
- Banishing Ritual includes all seven stones and places Heart of Doom at the
  bottom. Initial halls skip stones/guardians, retaining skipped cards ahead of
  unvisited deck cards; traps and treasure are postponed.
- Horde/Swarm markers use their increasing-health off-deck reserves. Treefolk
  expand the initial hall and draw more cards, including the recorded shortfall
  behavior when the deck runs out of monsters.
- Stormhold removes the same village supply cards; supplies retain the same
  instance IDs, ownership, origins and ordering.
- Starter decks, first-player policy, infinite basic supply and the weighted
  normal/special disease supply retain their previous state representation.
- Configuration/effect/catalog versions, events and sequence counters retain
  their previous values. The canonical configuration hash is adapter-provided so
  Python's historical JSON serialization remains the artifact identity.

## Errors, visibility and versioning

`SetupError` carries ordered `{path, message}` issues. `SetupChoiceRequired` carries
the allocation prompt. The worker transports these fields; Python re-raises the
existing public exception classes. No caller needs to parse error message text to
discover allocation or validation details.

Setup results contain hidden deck orders, all starting hands and RNG state. They
are server-private. The shared package being importable in a browser does not
authorize sending this result or the seed to players. Existing preview projections
remain separate, and the server continues to own authoritative match state.

`ENGINE_VERSION` changes with this implementation. Rebuild and restart the Python
application after source changes; its Node worker reloads when rebuilt output
changes. No CSV/SQLite migration or catalog rebuild is needed for this engine port.

## Verification

`backend/tests/migration/reference/setup/` retains the old Python implementation for tests only.
`backend/tests/migration/test_shared_setup.py` compares entire state/event results across classic
seeds, Unicode/large integer seeds, all environments, every hero/monster group,
all multipliers, feature combinations, allocations, random-environment trimming,
configuration errors and focused initial Treefolk halls. The existing per-card
contracts run through the new compatibility facade and TypeScript core.

Node/browser tests use independently computed SHA-256 vectors and random streams,
including rejection sampling and large counters. They also verify identical setup
results from immutable inputs and isolated transaction snapshots. The full suite
covers existing turns, choices, effects and backend setup responses.

Turn commands, state-changing effect atoms, continuation frames and in-play hall
workflows have since moved to TypeScript, as recorded in
[the migration summary](typescript-migration.md). The subsequently added
[`BattleDraft`/`SubmitBattleTeam` API](battle-team-api.md) provides local selections
and formal battle submission.
