import {PublicTableArea} from '../../shared/components/public-table-area/index.js';
import {PlayerDeckArea, type CardFlightOrigin, type PlayerDeckState, type PlayerResponse, type PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {tableState} from './table-state.js';
import {actionProgress, phaseLabel} from './model.js';
import {$} from './dom.js';
import {RestInteraction} from './rest-interaction.js';
import {CardActionInteraction} from './card-actions.js';
import {deckTransitions, supplyGainDestination} from './deck-transitions.js';
import {playerActivity} from './player-activity.js';
import {BoardPicker} from './board-picker.js';
import {EffectInteraction} from './effect-interaction.js';
import {BattleEditor} from './battle-editor.js';
import {MatchEventTimeline, hasEventTimeline} from './event-timeline.js';
import {traceCardMotion} from '../../shared/components/game-card/motion-trace.js';
import {GameResultsDialog} from '../../shared/components/game-results/index.js';
import {CardAttachments} from '../../shared/components/game-card/card-attachments.js';

/** The production host of the same public table and deck components used by game-probe. */
export class MatchTable {
  private readonly publicArea: PublicTableArea;
  private readonly deck: PlayerDeckArea;
  private readonly rest: RestInteraction;
  private readonly cardActions: CardActionInteraction;
  private readonly picker: BoardPicker;
  private readonly effects: EffectInteraction;
  private readonly battle: BattleEditor;
  private readonly timeline: MatchEventTimeline;
  private readonly results: GameResultsDialog;
  private resultsShownFor = '';
  private updatingControls = false;
  private pickRevision = -1;
  private state: PlayerDeckState | null = null;
  private matchId = '';
  private version = 0;
  private eventSequence = 0;
  private view: MatchView | null = null;
  private receivedView: MatchView | null = null;
  private syncing = false;
  private busy = false;
  private selection: readonly string[] = [];
  private error = '';
  constructor(private send: (command: GameCommand) => void, onAutoSortChange?: (enabled: boolean) => void) {
    this.rest = new RestInteraction(send);
    const changed = () => {if (this.view && !this.updatingControls && !this.syncing) this.controls(this.view, this.busy);};
    this.picker = new BoardPicker(changed);
    this.effects = new EffectInteraction(this.picker, send);
    this.battle = new BattleEditor(this.picker, send, message => this.setError(message), changed);
    this.cardActions = new CardActionInteraction(send, this.picker);
    const options = {overlayRoot: $('#match-overlays'), background: [$('#match-content'), $('#match-header')]};
    this.publicArea = new PublicTableArea($('#match-public-area'), {...options, idPrefix: 'match-public',
      onPlayerClick: id => this.effects.clickPlayer(id),
      onCardTargetClick: id => {if (!this.busy && !this.timeline?.isBusy) this.picker.clickInstance(id);},
      onSupplyClick: item => this.picker.clickSupply(item) || this.cardActions.clickSupply(item),
      onHallCardClick: item => {if (!this.busy && !this.deck.isBusy && !this.timeline?.isBusy && !this.picker.clickInstance(item.id)) this.battle.selectTarget(item.id);}});
    this.deck = new PlayerDeckArea($('#match-deck-area'), {...options, idPrefix: 'match-deck',
      onAutoSortChange,
      onCardTargetClick: id => {if (!this.busy && !this.timeline.isBusy) this.picker.clickInstance(id);},
      onBusyChange: busy => {
        if (!busy && !this.timeline?.isBusy && this.state) this.deck.setSelectedIds(this.selection.filter(id => this.state!.hand.some(card => card.id === id)));
        if (this.view && !this.syncing) this.controls(this.view, this.busy);
      },
      onHandCardClick: id => this.timeline?.isBusy || this.picker.clickInstance(id) || this.rest.clickHand(id)
        || (this.battle.active && !this.battle.effectMode ? this.battle.clickCard(id) : this.cardActions.clickHand(id)),
      onSelectionChange: ids => {
        if (this.syncing || this.timeline?.isBusy) return;
        if (this.busy) this.deck.setSelectedIds(this.selection.filter(id => this.state?.hand.some(card => card.id === id)));
        else this.deck.setSelectedIds(this.selection.filter(id => this.state?.hand.some(card => card.id === id)));
      },
      onResponse: (_id, id) => {
        if (id === 'match:results') {this.showResults(); return;}
        if (this.picker.choose(id) || this.effects.choose(id)) return;
        if (this.rest.choose(id)) {
          this.deck.setActiveTab('hand'); this.setSelected([]); this.controls(this.view!, this.busy); return;
        }
        if (this.cardActions.choose(id)) {
          if (id === 'village:buy') this.publicArea.setTab('village');
          else this.deck.setActiveTab('hand');
          this.setSelected([]); this.controls(this.view!, this.busy); return;
        }
        if (id === 'SubmitBattleTeam') {this.battle.submit(); return;}
        if (id === 'battle:confirm') {this.battle.confirmTarget(); return;}
        if (id === 'battle:effects') {this.cardActions.close(); this.battle.toggleEffects(); return;}
        const command = this.view?.legal_commands.find(command => command.type === id);
        if (id.startsWith('action:')) this.send({type: 'ChooseAction', action: id.slice(7)});
        else if (command) this.send({type: id});
      }});
    this.timeline = new MatchEventTimeline(this.publicArea, this.deck, $('#match-overlays'), changed);
    this.results = new GameResultsDialog(options.overlayRoot, options.background, () => location.assign('/play?view=room'));
  }
  receive(view: MatchView): void {
    const snapshot = tableState(view), reset = view.id !== this.matchId
      || (view.history?.epoch ?? 0) !== (this.receivedView?.history?.epoch ?? 0);
    if (reset) {this.closeBrowsers(); this.resultsShownFor = '';}
    if (reset || view.status !== 'finished') this.results.close();
    if (reset || view.version !== this.version) this.error = '';
    const committed: MatchView['event_log'] = [...view.event_log, ...view.card_motion ?? [], ...view.table_motion ?? []].sort((a, b) => a.sequence - b.sequence);
    const events = reset ? [] : committed.filter(event => event.sequence > this.eventSequence);
    traceCardMotion('match:snapshot', {previousVersion: this.version, version: view.version, reset,
      events: events.map(event => event.kind), previousSequence: this.eventSequence});
    const origins: Record<string, CardFlightOrigin> = {};
    if (!reset && view.version === this.version + 1) for (const event of events) {
      if (!supplyGainDestination(event) || event.player_id !== view.viewer_player_id || typeof event.card_id !== 'string') continue;
      const rect = this.publicArea.supplyCardRect(event.card_id);
      if (rect) origins[event.card_id] = {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
    }
    if (!reset && view.version === this.version) {this.view = view; this.timeline.syncPending(view); if (!this.timeline.isBusy) this.publicArea.setState(snapshot.table); return;}
    this.timeline.finish();
    this.view = view;
    const previousView = reset ? null : this.receivedView;
    if (reset || view.status !== 'active' || previousView?.turn?.number !== view.turn?.number
        || previousView?.turn?.active_player_id !== view.turn?.active_player_id)
      this.publicArea.clearPlayerActivity();
    const activity = playerActivity(view, previousView, events);
    this.receivedView = view;
    this.syncing = true;
    try {
      const previous = this.state;
      const steps = !reset && previous && view.version === this.version + 1 ? deckTransitions(previous, snapshot.deck,
        events, view.viewer_player_id, origins) : [];
      // Realtime refreshes can coalesce several committed commands. Public
      // departure events must still animate from the last displayed board.
      if (!reset && previousView && view.version > this.version
        && hasEventTimeline(events, tableState(previousView).table.dungeon, snapshot.table.dungeon))
        void this.timeline.play(tableState(previousView), snapshot, view, events).catch(error => console.error('Match event animation failed', error));
      else {
        this.publicArea.setState(snapshot.table);
        if (reset) this.deck.resetState(snapshot.deck);
        else if (steps.length) void this.deck.animateSequence(snapshot.deck, steps).catch(error => console.error('Card animation failed', error));
        else this.deck.setState(snapshot.deck, {clearSelection: reset, resetHandOrder: reset, closeBrowser: reset});
        if (snapshot.deck.revealed?.length) this.deck.setActiveTab('revealed');
      }
      this.state = snapshot.deck; this.matchId = view.id; this.version = view.version;
      this.eventSequence = Math.max(0, ...committed.map(event => event.sequence));
    } finally {this.syncing = false;}
    if (view.turn?.subphase === 'DUNGEON_DECLARE' && view.actor_player_id === view.viewer_player_id
      && (reset || previousView?.turn?.subphase !== 'DUNGEON_DECLARE')) this.publicArea.setTab('dungeon');
    this.timeline.syncPending(view);
    if (activity) this.publicArea.showPlayerActivity(activity.playerId, activity.text);
  }
  controls(view: MatchView, busy: boolean): void {
    if (this.updatingControls) return;
    this.updatingControls = true;
    try {this.renderControls(view, busy);} finally {this.updatingControls = false;}
  }
  private renderControls(view: MatchView, busy: boolean): void {
    this.view = view; this.busy = busy;
    this.timeline.syncPending(view);
    if (!['active', 'finished'].includes(view.status)) this.timeline.finish();
    const blocked = busy || this.deck.isBusy || this.timeline.isBusy;
    this.picker.receive(view, blocked);
    this.effects.receive(view, blocked);
    if (!blocked && this.picker.active && this.pickRevision !== this.picker.revision) {
      this.pickRevision = this.picker.revision;
      this.closeBrowsers();
    }
    this.rest.receive(view, blocked);
    this.battle.receive(view, blocked);
    this.cardActions.receive(view, blocked);
    const ownTurn = view.status === 'active' && view.turn?.active_player_id === view.viewer_player_id;
    const income = ownTurn && !view.unavailable_reason && ['TURN_START', 'VILLAGE_ABILITIES'].includes(view.turn!.subphase)
      ? view.viewer_resources.gold_income_preview : null;
    this.deck.setResources(['active', 'finished'].includes(view.status) ? {xp: view.viewer_resources.xp,
      gold: ownTurn ? view.viewer_resources.temporary_gold : 0,
      ...(typeof income === 'number' ? {goldIncomePreview: income} : {})} : null);
    const mayAct = view.status === 'active' && view.actor_player_id === view.viewer_player_id && !view.unavailable_reason;
    const choose = view.legal_commands.find(command => command.type === 'ChooseAction');
    const labels: Record<string, string> = {village: '访问村庄', dungeon: '进入地下城', rest: '休整'};
    const tones: Record<string, PlayerResponseChoice['tone']> = {village: 'gold', dungeon: 'violet', rest: 'blue'};
    const choices: PlayerResponseChoice[] = view.status === 'finished' && view.result ? [{id: 'match:results', label: '查看结算', tone: 'gold'}]
      : this.effects.active ? this.effects.choices
      : this.picker.active ? this.picker.choices
      : this.rest.active ? this.rest.choices
      : this.cardActions.choices ?? (mayAct && view.turn?.subphase === 'DUNGEON_PREPARE'
        ? [{id: 'battle:effects', label: '使用效果', pressed: this.battle.effectMode},
           {id: 'SubmitBattleTeam', label: '完成', tone: 'gold', disabled: !view.battle_preparation}]
      : mayAct && choose ? (choose.actions ?? []).map(action => ({id: `action:${action}`, label: labels[action] ?? action, tone: tones[action]}))
      : mayAct && view.turn?.subphase === 'DUNGEON_DECLARE' ? [
        {id: 'battle:confirm', label: '确认战斗', tone: 'gold', disabled: !this.battle.targetId || !view.battle_preparation},
        ...view.legal_commands.filter(command => command.type === 'ReviseBattleTeam').map(command => ({id: command.type, label: '调整队伍'}))]
      : mayAct ? view.legal_commands.filter(command => command.type === 'FinishTurn')
        .map(command => ({id: command.type, label: '结束回合', tone: 'red' as const})) : []);
    const progress = this.timeline.isBattleSettlement
      ? {action: '进入地下城', stage: '结算战斗', step: 4, total: 5} : actionProgress(view);
    const preview = this.battle.preview;
    const response: PlayerResponse = {id: `${view.id}:${view.version}`, prompt: this.effects.active ? this.effects.prompt : this.picker.active ? this.picker.prompt
      : this.rest.active ? this.rest.prompt : this.cardActions.prompt || (view.pending_choice ? '等待效果响应' : mayAct && choose ? '请选择本回合行动'
        : mayAct && view.turn?.subphase === 'DUNGEON_DECLARE' ? preview ? preview.battle_effects_pending ? '有效果待执行' : '' : '请选择地下城大厅中的战斗目标' : progress ? '' : phaseLabel(view.turn?.subphase)),
      isCurrentTurn: view.status === 'active' && view.turn?.active_player_id === view.viewer_player_id,
      progress,
      combat: this.battle.values,
      ...(preview && preview.rank !== null && preview.outcome_before_battle_effects ? {battlePreview: {rank: preview.rank,
        total: preview.calculation.effective_attack, outcome: preview.battle_effects_pending ? 'unknown' : preview.outcome_before_battle_effects}} : {}),
      error: this.error,
      selectedId: this.picker.active || this.effects.active ? undefined : this.rest.active ? this.rest.selectedId : this.cardActions.selectedId, choices, disabled: blocked};
    this.deck.setResponse(response);
    if (!this.deck.isBusy && !this.timeline.isBusy) {
      this.deck.setStatusOverrides(this.battle.handStatuses); this.publicArea.setStatusOverrides(this.battle.publicStatuses);
    }
    this.deck.setBattleDisplay({mandatoryIds: this.battle.mandatoryIds, equipment: this.battle.equipment});
    this.deck.setHighlightedIds((this.picker.active ? this.picker.highlightedIds : this.rest.active ? this.rest.highlightedIds
      : this.battle.active && !this.battle.effectMode ? [] : this.cardActions.highlightedIds)
      .filter(id => view.hand.some(card => card.instance_id === id)));
    this.deck.setCardTargets(this.picker.highlightedIds, this.picker.selectedIds);
    this.publicArea.setCardTargets(this.picker.highlightedIds, this.picker.selectedIds);
    const dungeonTargets = this.picker.highlightedIds.some(id => view.dungeons.some(dungeon => dungeon.hall.some(card => card.instance_id === id)) || view.settings.some(card => card.instance_id === id));
    this.publicArea.setTabAttention([...(dungeonTargets ? ['dungeon' as const] : []), ...(this.picker.supplyIds.length ? ['village' as const] : [])]);
    this.setSelected(this.picker.active ? this.picker.selectedIds : this.battle.selectedIds);
    this.publicArea.setHallSelection(this.picker.active ? this.picker.highlightedIds : blocked ? [] : this.battle.targetIds,
      this.picker.active ? this.picker.selectedIds : this.battle.targetId ? [this.battle.targetId] : []);
    this.publicArea.setPurchaseOptions(this.picker.active ? [] : this.cardActions.purchaseOptions);
    this.publicArea.setSupplySelection(this.picker.supplyIds, this.picker.selectedSupplyIds);
    this.publicArea.setPlayerSelection(this.effects.playerTargets);
    if (!blocked && !this.syncing && view.status === 'finished' && view.result && this.resultsShownFor !== view.id) this.showResults();
  }
  private showResults(): void {
    const view = this.view; if (!view?.result || this.timeline.isBusy || this.deck.isBusy) return;
    this.closeBrowsers(); this.resultsShownFor = view.id;
    this.results.show(view.players.flatMap(player => {
      const score = view.result!.players[player.player_id]; if (!score) return [];
      return [{id: player.player_id, name: player.display_name, avatarUrl: player.avatar_url,
        total: score.victory_points, cardPoints: score.card_victory_points, experiencePoints: score.experience_points,
        thunderstones: score.thunderstones, eliminated: score.eliminated, winner: view.result!.winner_ids.includes(player.player_id)}];
    }));
  }
  setSelected(ids: readonly string[]): void {this.selection = ids.filter(id => this.state?.hand.some(card => card.id === id)); if (!this.deck.isBusy && !this.timeline.isBusy) this.deck.setSelectedIds(this.selection);}
  setError(message: string): void {
    if (message === this.error) return;
    this.error = message; if (this.view && !this.updatingControls && !this.syncing) this.controls(this.view, this.busy);
  }
  setAutoSort(enabled: boolean): void {this.deck.setAutoSort(enabled, {notify: false});}
  finish(): void {this.timeline.finish(); this.deck.finish(); this.publicArea.finish();}
  closeBrowsers(): void {CardAttachments.closeAll(); this.results?.close(); this.cardActions.close(); this.deck.closeBrowser(); this.publicArea.closeBrowsers();}
  dispose(): void {this.results.dispose(); this.timeline.dispose(); this.cardActions.dispose(); this.picker.dispose(); this.deck.dispose(); this.publicArea.dispose();}
}
