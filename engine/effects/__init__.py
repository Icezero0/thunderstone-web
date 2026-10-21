"""Validated JSON ability definitions and their pure state interpreter."""

from engine.effects.compiler import (Ability, EffectCompileError, EffectsRuleset,
                                     load_ruleset)


def __getattr__(name: str):
    if name == "EffectError":
        from engine.effects.runtime import EffectError
        return EffectError
    raise AttributeError(name)

__all__ = ["Ability", "EffectCompileError", "EffectsRuleset", "EffectError",
           "load_ruleset"]
