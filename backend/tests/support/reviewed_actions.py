"""Small in-memory scenarios which always execute the current TypeScript engine."""
from copy import deepcopy
from dataclasses import asdict

from backend.app.integrations.game_engine.api import apply_command, legal_commands
from backend.app.integrations.game_engine.shared.client import client


class ActionScenario:
    def __init__(self, base, snapshot, effects=None):
        self.state = deepcopy(base)
        self.snapshot = snapshot
        self.effects = effects
        self.events = []
        self.state['zones'].setdefault('destroyed', [])
        for zone, pile in list(self.state['zones'].items()):
            if zone.startswith(('player:', 'hall:', 'dungeon:', 'village_supply:')):
                for item in pile:
                    self.state['instances'][item]['owner_player_id'] = None
                self.state['zones']['destroyed'].extend(pile)
                self.state['zones'][zone] = []
        self.state.update(chosen_action='dungeon', subphase='DUNGEON_PREPARE',
                          timing_window='DUNGEON_PREPARE', active_player_id='alice',
                          active_settings=[], battle_context={'equipped_weapon_by_hero': {}})
        if effects:
            self.state['effects_version'] = effects.version

    def add(self, card_id, player='alice', part='hand', zone=None):
        zone = zone or f'player:{player}:{part}'
        item = f"CI-{self.state['next_instance_sequence']:06d}"
        self.state['next_instance_sequence'] += 1
        self.state['instances'][item] = {'card_id': card_id,
            'owner_player_id': zone.split(':')[1] if zone.startswith('player:') else None,
            'origin': 'review_regression', 'flags': {}}
        self.state['zones'].setdefault(zone, []).append(item)
        return item

    def do(self, kind, **args):
        actor = self.state['pending_choice']['player_id'] if self.state['pending_choice'] else 'alice'
        result = apply_command(self.state, {'type': kind, 'player_id': actor, **args},
                               snapshot=self.snapshot, effects=self.effects)
        self.state = result['state']
        self.events.extend(result['events'])
        return result

    def activate(self, source, ability):
        return self.do('ActivateAbility', source_instance_id=source, ability_id=ability)

    def legal(self):
        return legal_commands(self.state, snapshot=self.snapshot, effects=self.effects)

    def can_activate(self, source, ability):
        return any({'source_instance_id': source, 'ability_id': ability} in command.get('options', [])
                   for command in self.legal())

    def combat(self, effects):
        return client.call('combat_values', {'input': {'cards': self.snapshot.cards,
            'mechanics': [asdict(m) for m in effects.mechanics], 'state': self.state}, 'rank': 1})
