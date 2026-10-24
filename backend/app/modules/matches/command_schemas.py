"""Untrusted player intent, without authoritative identities or state fields."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

from backend.app.modules.matches.schemas import MatchCommand


Identifier = Annotated[str, Field(strict=True, min_length=1, max_length=256)]
InstanceIds = Annotated[list[Identifier], Field(max_length=1000)]


class Intent(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChooseAction(Intent):
    type: Literal["ChooseAction"]
    action: Literal["village", "dungeon", "rest"]


class FinishStep(Intent):
    type: Literal["FinishAbilities", "FinishBuying", "FinishUpgrading", "SkipRestDestroy", "FinishTurn"]


class BuyCard(Intent):
    type: Literal["BuyCard"]
    card_id: Identifier


class ActivateAbility(Intent):
    type: Literal["ActivateAbility"]
    ability_id: Identifier
    source_instance_id: Identifier


class UpgradeHero(Intent):
    type: Literal["UpgradeHero"]
    source_instance_id: Identifier
    target_card_id: Identifier


class InstanceAction(Intent):
    type: Literal["RestDestroy", "UseSpell"]
    instance_id: Identifier


class EquipWeapon(Intent):
    type: Literal["EquipWeapon"]
    hero_instance_id: Identifier
    weapon_instance_id: Identifier


class BattleDraftSelection(Intent):
    """Only mutable choices cross the API; revision/actor fields are injected."""

    target_instance_id: Identifier
    hero_instance_ids: InstanceIds
    support_instance_ids: InstanceIds
    equipment: Annotated[dict[Identifier, InstanceIds], Field(max_length=1000)]


class SubmitBattleTeam(Intent):
    type: Literal["SubmitBattleTeam"]
    draft: BattleDraftSelection


class AssignDiseasePenalty(Intent):
    type: Literal["AssignDiseasePenalty"]
    instance_id: Identifier
    attack_type: Literal["attack", "magic_attack"]
    order: InstanceIds | None = None


class AssignStrengthPenalty(Intent):
    type: Literal["AssignStrengthPenalty"]
    instance_id: Identifier
    hero_instance_id: Identifier


class ResolveChoice(Intent):
    type: Literal["ResolveChoice"]
    instance_ids: InstanceIds


class ResolveResponse(Intent):
    type: Literal["ResolveResponse", "ResolveDiseaseReplacement"]
    source_instance_id: Identifier | None = None
    recipient_id: Identifier | None = None


class ResolveReusedAbility(Intent):
    type: Literal["ResolveReusedAbility"]
    ability_id: Identifier


class ResolveEffectUpgrade(Intent):
    type: Literal["ResolveEffectUpgrade"]
    source_instance_id: Identifier | None = None
    target_card_id: Identifier | None = None


class ResolveValueChoice(Intent):
    type: Literal["ResolveValueChoice"]
    value: Annotated[StrictStr, Field(max_length=256)] | StrictBool | Annotated[StrictInt, Field(ge=-(2**53-1), le=2**53-1)]


class ResolveCardOrder(Intent):
    type: Literal["ResolveCardOrder"]
    instance_ids: InstanceIds


class ResolveEffectPurchase(Intent):
    type: Literal["ResolveEffectPurchase"]
    card_id: Identifier | None = None


class ResolveEffectOrder(Intent):
    type: Literal["ResolveEffectOrder"]
    effect_ids: InstanceIds


PlayerIntent = Annotated[
    ChooseAction | FinishStep | BuyCard | ActivateAbility | UpgradeHero | InstanceAction |
    EquipWeapon | SubmitBattleTeam | AssignDiseasePenalty | AssignStrengthPenalty |
    ResolveChoice | ResolveResponse | ResolveReusedAbility | ResolveEffectUpgrade |
    ResolveValueChoice | ResolveCardOrder | ResolveEffectPurchase | ResolveEffectOrder,
    Field(discriminator="type"),
]


class PlayCommand(MatchCommand):
    command: PlayerIntent
