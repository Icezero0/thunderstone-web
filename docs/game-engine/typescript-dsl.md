# Shared TypeScript DSL compilation and evaluation

## Implemented boundary

The reviewed `thunderstone.effects/1` JSON files remain the source of abilities.
The shared package validates these definitions and executes them inside formal
command transactions. It also exposes read-only evaluation for browser previews.
Both server ESM and the browser bundle export the same implementation.

| Responsibility | Implementation |
| --- | --- |
| Schema, source IDs, operations, parameters and lexical variable checks | `effects/compiler.ts` |
| Static filter and continuous mechanic validation | `effects/mechanics.ts` |
| Typed expressions, conditions, queries and evaluation snapshot | `effects/dsl.ts` |
| Queries, conditions and integer arithmetic | `effects/evaluator.ts` |
| Reading reviewed JSON files and preserving the existing SHA-256 artifact version | Python compiler adapter |
| Applying atoms, RNG, choices, replacements, scheduling and continuation frames | `effects/execute.ts`, `effects/atoms.ts`, `effects/responses.ts`, `turn/commands.ts` |

Compiling a `destroy` or `draw` node validates its definition. `applyCommand`
executes the node against a copy of the supplied state and returns state, events
and legal commands. The server stores the returned state; the browser uses only
read-only calculation exports.

## Public API

```typescript
const definitions = compileRuleset(source, cards);
const evaluation = new EffectEvaluation(snapshot);
const heroes = evaluation.query({zone: 'active_hand', tag: '英雄'});
const xp = evaluation.expression({resource: 'xp'});
const allowed = evaluation.condition({
  compare: {left: {resource: 'xp'}, op: 'ge', right: 2},
});
```

`compileRuleset` accepts untrusted JSON, checks it and returns normalized ability
records. It rejects unknown keys/operators, invalid source lines, duplicate IDs,
unsupported parameters, unbound variables and invalid selection bounds. The
adapter fingerprints the original source using the existing canonical JSON format;
this migration does not change effects versions or require rewriting saved state.

`validateQuery`, `validateExpression`, `validateCondition` and `validateFilter`
are exported for isolated inputs. Direct `EffectEvaluation` methods expect
validated definitions. The Node bridge validates each isolated request before
evaluation. No JSON operator resolves executable code or an arbitrary global name.

An evaluator belongs to one immutable snapshot and may memoize combat traces
within that evaluation. Construct another evaluator after changing a local draft.
No match state, RNG or result cache is kept between worker requests.

## Query scopes and identity

Queries preserve candidate order and ties. Supply tops use sorted zone names;
player scopes follow the fixed player order and exclude eliminated players.

| Scope | Candidates |
| --- | --- |
| `active_hand`, `subject_hand`, `other_hand`, `all_hand` | Hand cards in the requested player scope |
| `active_discard`, `subject_discard`, `other_discard`, `all_discard` | Discard cards in that scope |
| `active_control`, `subject_control`, `other_control` | Controlled cards |
| `village_supply_top`, `hero_supply_top`, `active_hand_or_village_top` | Relevant supply tops, optionally after the active hand |
| `hall` | Visible halls, including rank zero |
| `event_source`, `event_hero`, `defeated_monster`, `event_supply_top` | The current event's instances or supply top |
| `defeated_this_turn` | Recorded defeated instances |
| `reveal_zone` | The current temporary reveal area |
| `collection` | The current ability/source's saved collection |
| `bound` | A bound instance or list of instances |

Static filters operate on card definitions; dynamic filters use current equipment,
adjusted strength, used-card history, location, flags and event context. Hero
identity uses the explicit `英雄` tag. Full-card copying changes the queried
definition; ability-only copying preserves identity. Color dragons share a family.

The `participating` filter uses the submitted battle team plus current forced
combat exclusions. `active_hand` still includes benched heroes, and previously
used cards retain their history. See [battle team selection](battle-team-api.md).

## Arithmetic and limits

Expressions cover card counts, sums/maxima of printed stats, bound card stats,
player resources, event rank/price, surviving player counts, current combat totals,
bound numeric values and binary `add/sub/mul/div/min/max`. Division floors toward
negative infinity, matching Python. Missing numeric/card bindings, division by
zero and arithmetic outside ±10,000 raise rule errors.

`all` and `any` short-circuit. Conditions also support negation, existence,
comparison, chosen action, active settings, enum choices and active-player checks.

Existing bounds remain: effect trees have at most 128 nodes and depth 16; a query
may return at most 200 candidates before its extremum selector. The TypeScript
validator also carries the depth limit through query-to-expression recursion,
closing the old depth reset path. This affects pathological nested definitions,
not any reviewed card. Invalid explicit `null` values are rejected rather than
being interpreted as absent optional fields.

## Visibility and transport

`packages/engine/src/turn/transaction.ts` supplies the current state and reviewed
mechanics to `EffectEvaluation` during a command. This is a **private server-only**
input, including hidden zones and revealed collections. It is not an HTTP response.

`backend/app/integrations/game_engine/shared/projection.py` constructs a limited
calculation snapshot for development tools: the active player's visible calculation
inputs and public hall. Query evaluation
does not cause additional hidden data to be sent to the browser. A client cannot
reconstruct arbitrary server queries from this limited view; missing required
player zones produce an error rather than being treated as empty.

The JSON-lines worker adds `compile_ruleset`, `effect_query`, `effect_expression`
and `effect_condition`. Each call supplies its inputs explicitly. The Python
adapter translates shared compile errors to `EffectCompileError`, turn failures
to `TurnError`, and setup failures to `SetupError`. The DSL executes in TypeScript.

## Verification

- The original DSL schema retains differential compilation checks against the
  frozen Python compiler. Current Node/browser builds compile all 446 abilities
  and 227 mechanics, including the post-migration `discard_until`, `battle_aura`
  and scoped economy rules verified directly in the shared engine.
- Browser and Node builds compile the same full reviewed set and evaluate frozen
  snapshots identically.
- Differential tests cover every query zone, static/dynamic filters, ties,
  equipment, copying, eliminated players, arithmetic and conditions.
- Negative tests cover unknown fields, unbound names, malformed choices, explicit
  nulls, numeric/recursion limits and recovery after an error.
- The full existing per-card and turn suite runs through the migrated entry points.

[Deterministic RNG and setup](typescript-setup.md), state-changing atoms and
serializable workflows have all migrated; see the [migration record](typescript-migration.md).
The browser team editor remains separate work.
