"""Public/cross-player flights with per-viewer faces and opaque hidden identities."""


def table_motion_view(events, instances, viewer, catalog, add_card):
    known = {key: value['card_id'] for key, value in instances.items()}
    for event in events:
        if event.get('instance_id') and event.get('card_id'):
            known.setdefault(event['instance_id'], event['card_id'])
    reveals = {event['zone']: event for event in events if event.get('kind') == 'cards_revealed' and event.get('zone')}
    anchor_players = {event['anchor_instance_id']: event['player_id'] for event in events
                      if event.get('kind') == 'card_attached' and event.get('player_id')}
    handled = {'monster_defeated', 'monster_returned_to_deck', 'effect_hall_relocated', 'thunderstone_acquired',
               'thunderstone_returned_to_deck', 'treasure_claimed', 'hall_card_entered', 'guardian_entered_rank_0',
               'trap_revealed', 'card_destroyed', 'hall_monster_exchanged'}

    def attachment(anchor, kind=None):
        owner = anchor_players.get(anchor) or instances.get(anchor, {}).get('owner_player_id')
        return {'kind': 'attachment', 'anchor_id': anchor,
                **({'player_id': owner} if owner else {}), **({'attachment_kind': kind} if kind else {})}

    def location(raw, item, rank=None):
        if not isinstance(raw, str): return None
        if raw in reveals and viewer in reveals[raw].get('visible_to', []):
            return {'kind': 'owned', 'zone': 'revealed'}
        if raw.startswith('player:'):
            _, pid, part = raw.split(':', 2)
            if pid == viewer:
                if part.startswith('revealed_'): part = 'revealed'
                if part == 'refill_add': part = 'aside'
                if part == 'control':
                    part = 'treasures' if '宝藏' in catalog.get(known.get(item), {}).get('tags', '').split('|') else 'aside'
                if part in {'hand', 'draw', 'discard', 'aside', 'treasures', 'revealed'}:
                    return {'kind': 'owned', 'zone': part}
            return {'kind': 'player', 'player_id': pid, 'zone': part}
        if raw.startswith('dungeon:'): return {'kind': 'dungeon', 'dungeon_id': raw.split(':')[1]}
        if raw.startswith('revealed:'): return {'kind': 'dungeon', 'dungeon_id': raw.split(':')[1].split('_')[0]}
        if raw.startswith('hall:'): return {'kind': 'hall', 'dungeon_id': raw.split(':')[1], 'rank': rank or 0}
        # The anchor is public or the viewer's own card; identifying the anchor
        # does not expose the identity/order of a hidden drawn card.
        if raw.startswith('attached:'):
            return attachment(raw.split(':', 1)[1])
        return None

    def flight(event, item, source, destination, public=False):
        if not source or not destination: return None
        own = source['kind'] == 'owned' or destination['kind'] == 'owned'
        visible = own or public
        return {'source': source, 'destination': destination, 'card': {
            'instance_id': item if own or source['kind'] == 'attachment' or destination['kind'] == 'attachment' else f"motion:{event['sequence']}:{len(rows)}",
            **({'card_id': add_card(known[item])} if visible and item in known else {})}}

    rows = []
    for index, event in enumerate(events):
        if not isinstance(event.get('sequence'), int): continue
        kind, steps = event.get('kind'), []
        if kind == 'card_moved':
            item = event['instance_id']; raw_source, raw_target = event['source'], event['destination']
            following = index + 1
            while following < len(events) and events[following].get('kind') == 'card_moved': following += 1
            cleanup = events[following] if following < len(events) else {}
            if cleanup.get('kind') == 'turn_hand_discarded' and item in cleanup.get('instance_ids', []) \
                    and raw_source.endswith(':hand') and raw_target.endswith(':discard'):
                continue
            source = location(raw_source, item, event.get('source_rank'))
            target = location(raw_target, item, event.get('destination_rank'))
            attached = next((e for e in events[index + 1:index + 9] if e.get('kind') == 'card_attached' and e.get('instance_id') == item), None)
            released = next((e for e in events[index + 1:index + 9] if e.get('kind') == 'attachment_released' and item in e.get('instance_ids', [])), None)
            if attached:
                target = attachment(attached['anchor_instance_id'], attached['attachment_kind'])
            if released:
                source = attachment(released['anchor_instance_id'])
            if not source or not target or source['kind'] == target['kind'] == 'owned': continue
            if source['kind'] == target['kind'] == 'dungeon': continue
            semantic = next((candidate for candidate in events[index + 1:index + 9] if candidate.get('kind') in handled and
                item in (candidate.get('instance_id'), candidate.get('target_instance_id'), candidate.get('target'), candidate.get('replacement'))), None)
            if semantic: continue
            public = (source['kind'] in {'hall', 'attachment'} or target['kind'] in {'hall', 'attachment'}
                or raw_source.endswith((':discard', ':control', ':aside')) or raw_target.endswith(':discard')
                or reveals.get(raw_source, {}).get('public') or reveals.get(raw_target, {}).get('public')
                or any(e.get('kind') in {'card_borrowed', 'borrowed_card_returned'} and e.get('instance_id') == item for e in events[index + 1:index + 9]))
            steps = [flight(event, item, source, target, public)]
        elif kind in {'cards_drawn', 'turn_hand_discarded'} and event.get('player_id') and event.get('player_id') != viewer:
            pid = event['player_id']
            def transfer(items):
                return [flight(event, item, {'kind': 'player', 'player_id': pid, 'zone': 'draw' if kind == 'cards_drawn' else 'hand'},
                    {'kind': 'player', 'player_id': pid, 'zone': 'hand' if kind == 'cards_drawn' else 'discard'}, kind != 'cards_drawn') for item in items]
            previous = events[index - 1] if index else {}
            shuffled = set(previous.get('order', [])) if kind == 'cards_drawn' and previous.get('kind') == 'player_deck_shuffled' and previous.get('player_id') == pid else set()
            if shuffled:
                before = [item for item in event.get('instance_ids', []) if item not in shuffled]
                if before: rows.append({'sequence': event['sequence'], 'kind': 'table_card_motion', 'steps': transfer(before)})
                rows.append({'sequence': event['sequence'], 'kind': 'player_shuffle_motion', 'player_id': pid, 'count': len(shuffled)})
                steps = transfer([item for item in event.get('instance_ids', []) if item in shuffled])
            else: steps = transfer(event.get('instance_ids', []))
        elif kind == 'player_deck_shuffled' and event.get('player_id') and event.get('player_id') != viewer:
            following = events[index + 1] if index + 1 < len(events) else {}
            if following.get('kind') != 'cards_drawn' or following.get('player_id') != event.get('player_id'):
                rows.append({'sequence': event['sequence'], 'kind': 'player_shuffle_motion', 'player_id': event['player_id'], 'count': len(event.get('order', []))})
        elif kind == 'hall_monster_exchanged':
            a, b = event['target'], event['replacement']
            hall = location(event['hall_zone'], a, event.get('rank'))
            origin = location(event['origin'], b, event.get('origin_rank'))
            steps = [flight(event, a, hall, origin, True), flight(event, b, origin, hall, True)]
        elif kind in {'dungeon_top_shuffled', 'destroyed_traps_shuffled'} and event.get('deck_zone'):
            rows.append({'sequence': event['sequence'], 'kind': 'dungeon_shuffle_motion',
                         'dungeon_id': event['deck_zone'].split(':')[1], 'count': event.get('count', 1)})
        if any(steps):
            rows.append({'sequence': event['sequence'], 'kind': 'table_card_motion', 'steps': [step for step in steps if step]})
    return rows
