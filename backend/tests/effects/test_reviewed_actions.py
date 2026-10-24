"""Approved review boundaries through public TS commands, using actual card data."""
from dataclasses import asdict
import unittest

from backend.app.integrations.game_engine.api import load_catalog, start_game, TurnError
from backend.app.integrations.game_engine.effects.compiler import load_ruleset, compile_ruleset
from backend.tests.support.reviewed_actions import ActionScenario
from backend.tests.support.setup import config, request


class ReviewedActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.effects = load_ruleset(cls.snapshot.cards)
        rules = config()
        rules['selection']['dungeon_features']['mode'] = 'manual'
        settings = request(rules, seed='approved-action-review')
        settings['player_ids'] = ['alice', 'bob', 'carol']
        settings['first_player'] = {'mode': 'fixed', 'player_id': 'alice'}
        cls.base = start_game(settings, snapshot=cls.snapshot)['state']

    def scenario(self, action='dungeon', effects=None):
        f = ActionScenario(self.base, self.snapshot, effects or self.effects)
        if action == 'village':
            f.state.update(chosen_action='village', subphase='VILLAGE_ABILITIES',
                           timing_window='VILLAGE_ABILITIES', battle_context=None)
        return f

    def custom(self, body):
        return compile_ruleset({'schema_version': 'thunderstone.effects/1', 'abilities': [{
            'id': 'TS-0004-A01', 'source_card_id': 'TS-0004', 'kind': 'activated',
            'source_zone': 'active_hand', 'usage': 'once_per_turn', 'actions': ['dungeon'],
            'conditions': [], 'body': body}], 'mechanics': [asdict(m) for m in self.effects.mechanics]}, self.snapshot.cards)

    def test_tavern_short_target_ends_without_a_permanent_choice(self):
        f = self.scenario('village')
        source = f.add('TS-0216'); hero = f.add('TS-0001'); f.add('TS-0001')
        lone = f.add('TS-0003', 'bob')
        f.activate(source, 'TS-0216-A02')
        self.assertEqual(f.state['pending_choice']['kind'], 'effect_select')
        f.do('ResolveChoice', instance_id=hero)
        self.assertIsNone(f.state['pending_choice'])
        self.assertIn(source, f.state['zones']['destroyed'])
        self.assertIn(hero, f.state['zones']['destroyed'])
        self.assertEqual(f.state['zones']['player:bob:hand'], [lone])
        self.assertTrue(any(c['type'] == 'FinishAbilities' for c in f.legal()))

    def test_chaos_empty_player_neither_discards_nor_receives_a_card(self):
        f = self.scenario(); source = f.add('TS-0298'); food = f.add('TS-0004')
        torch = f.add('TS-0003', 'carol')
        f.activate(source, 'TS-0298-A01'); f.do('ResolveChoice', instance_id=food)
        f.do('ResolveChoice', instance_id=torch)
        self.assertIsNone(f.state['pending_choice'])
        self.assertEqual(f.state['zones']['player:bob:hand'], [])
        self.assertEqual(f.state['zones']['player:carol:hand'], [food])
        assignment = next(e for e in f.events if e['kind'] == 'cards_randomly_distributed')
        self.assertEqual([a['player_id'] for a in assignment['assignments']], ['carol'])

    def test_chaos_random_disease_uses_the_receivers_replacement(self):
        f = self.scenario(); source = f.add('TS-0298'); disease = f.add('TS-0714')
        f.add('TS-0239', 'bob'); torch = f.add('TS-0003', 'bob')
        f.activate(source, 'TS-0298-A01'); f.do('ResolveChoice', instance_id=disease)
        f.do('ResolveChoice', instance_id=torch); f.do('ResolveChoice', instance_id=torch)
        self.assertIsNone(f.state['pending_choice'])
        self.assertNotIn(disease, f.state['instances'])
        self.assertTrue(any(e['kind'] == 'disease_replacement_applied' and e['player_id'] == 'bob' for e in f.events))

    def test_gain_is_external_entry_into_hand_draw_or_discard(self):
        for origin in ('control', 'discard'):
            for destination in ('hand', 'draw_top', 'discard'):
                with self.subTest(origin=origin, destination=destination):
                    rules = self.custom({'op': 'select', 'query': {'zone': 'active_' + origin}, 'bind': 'chosen',
                        'min': 1, 'max': 1, 'then': {'op': 'move', 'target': {'var': 'chosen'}, 'destination': destination}})
                    f = self.scenario(effects=rules); source=f.add('TS-0004'); disease=f.add('TS-0714', part=origin)
                    f.add('TS-0239'); f.activate(source,'TS-0004-A01')
                    self.assertEqual(disease in f.state['instances'], origin=='discard')
                    self.assertEqual(any(e['kind']=='card_gained' for e in f.events), origin!='discard')

    def test_salvage_requires_three_cards_and_takes_bottom_before_reshuffling(self):
        f = self.scenario('village'); source=f.add('TS-0283'); f.add('TS-0003', part='draw')
        f.add('TS-0002', part='discard')
        self.assertFalse(f.can_activate(source,'TS-0283-A01'))
        last=f.add('TS-0001', part='discard'); bottom=f.state['zones']['player:alice:draw'][0]
        self.assertTrue(f.can_activate(source,'TS-0283-A01'))
        f.activate(source,'TS-0283-A01')
        revealed=next(e['instance_ids'] for e in f.events if e['kind']=='cards_revealed')
        self.assertEqual(len(revealed),3); self.assertEqual(revealed[0],bottom)
        f.do('ResolveChoice',instance_id=bottom)
        candidates=f.state['pending_choice']['candidate_instance_ids']
        f.do('ResolveChoice',instance_id=next(i for i in candidates if i!=last))
        self.assertIn(last,f.state['zones']['player:alice:hand'])

    def test_salvage_returns_own_revealed_disease_without_a_new_gain(self):
        f=self.scenario('village');source=f.add('TS-0283');f.add('TS-0239')
        disease=f.add('TS-0714',part='draw');dagger=f.add('TS-0002',part='draw');torch=f.add('TS-0003',part='draw')
        f.activate(source,'TS-0283-A01');f.do('ResolveChoice',instance_id=torch);f.do('ResolveChoice',instance_id=dagger)
        self.assertIn(disease,f.state['zones']['player:alice:hand'])
        self.assertFalse(any(e['kind'] in ('card_gained','disease_replacement_applied') for e in f.events))

    def test_time_bend_set_aside_disease_gain_pauses_cleanup_until_replacement_resolves(self):
        f=self.scenario('village');source=f.add('TS-0270');disease=f.add('TS-0714')
        f.add('TS-0003',part='draw');breaker=f.add('TS-0239',part='draw');f.add('TS-0423',part='draw')
        for _ in range(4):f.add('TS-0003',part='draw')
        f.activate(source,'TS-0270-A01');f.do('ResolveChoice',instance_id=disease)
        f.do('FinishAbilities');f.do('FinishBuying');f.do('FinishUpgrading');f.do('FinishTurn')
        self.assertEqual(f.state['pending_choice']['kind'],'disease_replacement')
        self.assertEqual(f.state['active_player_id'],'alice')
        self.assertFalse(f.state['turn_hand_public'])
        self.assertFalse(any(e['kind']=='TURN_ENDED' for e in f.events))
        f.do('ResolveDiseaseReplacement',source_instance_id=breaker)
        self.assertIsNone(f.state['pending_choice'])
        self.assertNotIn(disease,f.state['instances'])
        self.assertEqual(f.state['active_player_id'],'bob')
        self.assertTrue(f.state['turn_hand_public'])
        self.assertEqual(sum(e['kind']=='TURN_ENDED' for e in f.events),1)

    def test_empty_decks_end_oracle_and_time_bend_normally(self):
        for card, ability in [('TS-0219','TS-0219-A01'),('TS-0270','TS-0270-A01')]:
            with self.subTest(card=card):
                f=self.scenario(); source=f.add(card); f.activate(source,ability)
                self.assertIsNone(f.state['pending_choice'])
                self.assertEqual(f.state['zones']['player:alice:hand'],[source])
                self.assertTrue(any(e['kind']=='effect_choice_unavailable' for e in f.events))

    def test_redblade_offers_only_payable_branches(self):
        for hero_count, other_count in [(0,0),(0,1),(0,2),(0,3),(1,0),(1,1)]:
            with self.subTest(heroes=hero_count,others=other_count):
                f=self.scenario(); source=f.add('TS-0392')
                for _ in range(hero_count):f.add('TS-0001','bob')
                for _ in range(other_count):f.add('TS-0003','bob')
                f.activate(source,'TS-0392-A02')
                choice=f.state['pending_choice']
                if hero_count and hero_count+other_count>=2:
                    self.assertEqual(choice['options'],['hero','two_cards']);f.do('ResolveValueChoice',value='hero')
                elif other_count>=2:
                    if choice:self.assertEqual(choice['kind'],'effect_select');f.do('ResolveChoice',instance_ids=choice['candidate_instance_ids'][:2])
                self.assertIsNone(f.state['pending_choice'])
                expected=1 if hero_count else 2 if other_count>=2 else 0
                self.assertEqual(len(f.state['zones']['player:bob:discard']),expected)

    def test_missing_category_is_publicly_shown_but_bard_shows_only_one_spell(self):
        for card,ability,hand in [('TS-0389','TS-0389-A03','TS-0001'),('TS-0439','TS-0439-A02','TS-0001'),
            ('TS-0440','TS-0440-A02','TS-0001'),('TS-0442','TS-0442-A03','TS-0267')]:
            with self.subTest(card=card):
                f=self.scenario();source=f.add(card);item=f.add(hand,'bob');f.activate(source,ability)
                self.assertTrue(any(e['kind']=='cards_shown' and e['player_id']=='bob' and e['instance_ids']==[item] for e in f.events))
        f=self.scenario();source=f.add('TS-0394');spell=f.add('TS-0272','bob');f.add('TS-0267','bob');f.add('TS-0003','bob')
        f.activate(source,'TS-0394-A02');f.do('ResolveChoice',instance_id=spell)
        shown=[e for e in f.events if e['kind']=='cards_shown' and e['player_id']=='bob']
        self.assertEqual([e['instance_ids'] for e in shown],[[spell]])

    def test_weapon_activation_needs_equipment_except_the_explicit_axe(self):
        f=self.scenario();bow=f.add('TS-0232');axe=f.add('TS-0257')
        self.assertFalse(f.can_activate(bow,'TS-0232-A02'))
        self.assertTrue(f.can_activate(axe,'TS-0257-A02'))
        with self.assertRaises(TurnError):f.activate(bow,'TS-0232-A02')

    def test_diin_template_must_be_a_third_hero(self):
        f=self.scenario();diin=f.add('TS-0415');militia=f.add('TS-0001')
        self.assertFalse(f.can_activate(diin,'TS-0415-A02'))
        third=f.add('TS-0302');f.activate(diin,'TS-0415-A02')
        self.assertEqual(f.state['copied_heroes'][militia]['card_ids'],['TS-0302'])
        self.assertNotEqual(third,diin)

    def test_random_discard_fixes_its_count_before_mutating_hand(self):
        rules=self.custom({'op':'for_players','scope':'others','body':{'op':'random_discard','count':3}})
        f=self.scenario(effects=rules);source=f.add('TS-0004')
        for _ in range(3):f.add('TS-0003','bob')
        f.activate(source,'TS-0004-A01')
        self.assertEqual(len(f.state['zones']['player:bob:discard']),3)

    def staff(self, spell_card):
        f=self.scenario();staff=f.add('TS-0244');caster=f.add('TS-0435');spell=f.add(spell_card)
        f.do('EquipWeapon',hero_instance_id=caster,weapon_instance_id=staff)
        return f,staff,caster,spell

    def test_pure_spell_requires_explicit_use_before_full_recast(self):
        f,staff,caster,spell=self.staff('TS-0272')
        self.assertNotIn(spell,f.state.get('used_cards',[]))
        f.do('UseSpell',instance_id=spell)
        with self.assertRaises(TurnError):f.do('UseSpell',instance_id=spell)
        f.activate(staff,'TS-0244-A02')
        self.assertIsNone(f.state['pending_choice'])
        self.assertEqual(f.state['battle_context']['spell_cast_counts'][spell],2)
        trace=f.combat(self.effects)
        self.assertEqual(next(c['magic_attack'] for c in trace['components'] if c['instance_id']==spell),6)
        self.assertTrue(f.state['instances'][spell]['flags']['pending_turn_end_destruction'])
        f.state['battle_context']['battle_team']={'hero_instance_ids':[caster],'support_instance_ids':[]}
        self.assertNotIn(spell,[c['instance_id'] for c in f.combat(self.effects)['components']])

    def test_recast_dynamic_magic_is_recomputed_and_card_modifiers_are_not_multiplied(self):
        f,staff,caster,spell=self.staff('TS-0278')
        f.add('TS-0002');f.add('TS-0002');f.do('UseSpell',instance_id=spell);f.activate(staff,'TS-0244-A02')
        first=next(c['magic_attack'] for c in f.combat(self.effects)['components'] if c['instance_id']==spell)
        f.add('TS-0002');f.add('TS-0002')
        second=next(c['magic_attack'] for c in f.combat(self.effects)['components'] if c['instance_id']==spell)
        self.assertEqual(second-first,2)
        f.state['battle_context'].setdefault('card_modifiers',{})[spell]={'magic_attack':1}
        third=next(c['magic_attack'] for c in f.combat(self.effects)['components'] if c['instance_id']==spell)
        self.assertEqual(third-second,1)

    def test_recast_repeats_whirlwind_printed_and_active_parts(self):
        f,staff,caster,spell=self.staff('TS-0269')
        f.activate(spell,'TS-0269-A02')
        f.activate(staff,'TS-0244-A02')
        self.assertEqual(f.state['battle_context']['card_modifiers'][caster]['magic_attack'],2)
        self.assertEqual(next(c['magic_attack'] for c in f.combat(self.effects)['components'] if c['instance_id']==spell),4)
        self.assertEqual(sum(e['kind']=='ability_activated' and bool(e.get('reused')) for e in f.events),1)

    def test_recast_resumes_every_applicable_active_ability_after_a_choice(self):
        # Isolated DSL fixture: two active abilities on one spell exercise the
        # interpreter contract; these definitions never enter the card catalogue.
        staff_rule = asdict(self.effects.by_id('TS-0244-A02'))
        staff_rule.pop('event')
        def spell_rule(suffix, body):
            return {'id': 'TS-0272-A_test_' + suffix, 'source_card_id': 'TS-0272',
                'kind': 'activated', 'source_zone': 'active_hand', 'usage': 'once_per_turn',
                'actions': ['dungeon'], 'conditions': [], 'body': body}
        rules = compile_ruleset({'schema_version': self.effects.schema_version,
            'abilities': [staff_rule, spell_rule('choice', {'op': 'select',
                'query': {'zone': 'active_hand', 'tag': '英雄'}, 'bind': 'chosen', 'min': 1, 'max': 1,
                'then': {'op': 'mod_card', 'target': {'var': 'chosen'}, 'stat': 'attack', 'amount': 1}}),
                spell_rule('draw', {'op': 'draw', 'count': 1})],
            'mechanics': [asdict(m) for m in self.effects.mechanics]}, self.snapshot.cards)
        f=self.scenario(effects=rules);staff=f.add('TS-0244');caster=f.add('TS-0435')
        hero=f.add('TS-0001');spell=f.add('TS-0272');drawn=f.add('TS-0003',part='draw')
        f.do('EquipWeapon',hero_instance_id=caster,weapon_instance_id=staff)
        f.do('UseSpell',instance_id=spell);f.activate(staff,'TS-0244-A02')
        self.assertEqual(f.state['pending_choice']['kind'],'effect_select')
        self.assertEqual(f.state['battle_context']['spell_cast_counts'][spell],1)
        f.do('ResolveChoice',instance_id=hero)
        self.assertIsNone(f.state['pending_choice'])
        self.assertEqual(f.state['battle_context']['spell_cast_counts'][spell],2)
        self.assertEqual(f.state['battle_context']['card_modifiers'][hero]['attack'],1)
        self.assertIn(drawn,f.state['zones']['player:alice:hand'])
        self.assertEqual(sum(e['kind']=='ability_activated' and bool(e.get('reused')) for e in f.events),2)
        self.assertEqual(next(c['magic_attack'] for c in f.combat(rules)['components'] if c['instance_id']==spell),6)

    def test_recast_respects_a_current_dungeon_deck_lock(self):
        f,staff,caster,spell=self.staff('TS-0268')
        f.do('UseSpell',instance_id=spell)
        target=f.add('TS-0476',zone='hall:main');f.add('TS-0523',zone='hall:main')
        f.activate(staff,'TS-0244-A02')
        self.assertIsNone(f.state['pending_choice'])
        self.assertIn(target,f.state['zones']['hall:main'])
        self.assertFalse(any(e['kind']=='ability_activated' and e.get('reused') for e in f.events))


if __name__ == '__main__':
    unittest.main()
