import {PublicTableArea} from '../../shared/components/public-table-area/index.js';
import {PlayerDeckArea, type CardFlightOrigin, type PlayerDeckState, type PlayerResponse, type PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {tableState} from './table-state.js';
import {actionProgress, phaseLabel} from './model.js';
import {$} from './dom.js';
import {RestInteraction} from './rest-interaction.js';
import {CardActionInteraction} from './card-actions.js';
import {deckTransitions} from './deck-transitions.js';
import {playerActivity} from './player-activity.js';

/** The production host of the same public table and deck components used by game-probe. */
export class MatchTable {
  private readonly publicArea: PublicTableArea;
  private readonly deck: PlayerDeckArea;
  private readonly rest: RestInteraction;
  private readonly cardActions: CardActionInteraction;
  private state: PlayerDeckState | null = null;
  private matchId = '';
  private version = 0;
  private eventSequence = 0;
  private view: MatchView | null = null;
  private receivedView: MatchView | null = null;
  private syncing = false;
  private busy = false;
  private selection: readonly string[] = [];
  constructor(private send: (command: GameCommand) => void, private selectHand: (ids: readonly string[]) => void,
    target: (id: string) => void, completeBattle: () => void, respond: () => void) {
    this.rest = new RestInteraction(send);
    this.cardActions = new CardActionInteraction(send, {
      selected: id => this.selection.includes(id),
      toggle: id => this.selectHand(this.selection.includes(id) ? this.selection.filter(item => item !== id) : [...this.selection, id]),
    });
    const options = {overlayRoot: $('#match-overlays'), background: [$('#match-content'), $('#match-header')]};
    this.publicArea = new PublicTableArea($('#match-public-area'), {...options, idPrefix: 'match-public',
      onSupplyClick: item => this.cardActions.clickSupply(item), onHallCardClick: item => {if (!this.busy && !this.deck.isBusy) target(item.id);}});
    this.deck = new PlayerDeckArea($('#match-deck-area'), {...options, idPrefix: 'match-deck',
      onBusyChange: busy => {
        if (!busy && this.state) this.deck.setSelectedIds(this.selection.filter(id => this.state!.hand.some(card => card.id === id)));
        if (this.view && !this.syncing) this.controls(this.view, this.busy);
      },
      onHandCardClick: id => this.rest.clickHand(id) || this.cardActions.clickHand(id),
      onSelectionChange: ids => {
        if (this.syncing) return;
        if (this.busy) this.deck.setSelectedIds(this.selection.filter(id => this.state?.hand.some(card => card.id === id)));
        else this.selectHand(ids);
      },
      onResponse: (_id, id) => {
        if (this.rest.choose(id)) {
          this.deck.setActiveTab('hand'); this.setSelected([]); this.controls(this.view!, this.busy); return;
        }
        if (this.cardActions.choose(id)) {
          if (id === 'village:buy') this.publicArea.setTab('village');
          else this.deck.setActiveTab('hand');
          this.setSelected([]); this.controls(this.view!, this.busy); return;
        }
        if (id === 'SubmitBattleTeam') {completeBattle(); return;}
        if (id === 'effect:respond') {this.closeBrowsers(); respond(); return;}
        const command = this.view?.legal_commands.find(command => command.type === id);
        if (id.startsWith('action:')) this.send({type: 'ChooseAction', action: id.slice(7)});
        else if (command) this.send({type: id});
      }});
  }
  receive(view: MatchView): void {
    const snapshot = tableState(view), reset = view.id !== this.matchId;
    const events = reset ? [] : view.event_log.filter(event => event.sequence > this.eventSequence);
    const origins: Record<string, CardFlightOrigin> = {};
    if (!reset && view.version === this.version + 1) for (const event of events) {
      if (event.kind !== 'card_bought' || event.player_id !== view.viewer_player_id || typeof event.card_id !== 'string') continue;
      const rect = this.publicArea.supplyCardRect(event.card_id);
      if (rect) origins[event.card_id] = {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
    }
    this.view = view; this.publicArea.setState(snapshot.table);
    if (!reset && view.version === this.version) return;
    const previousView = reset ? null : this.receivedView;
    if (reset || view.status !== 'active' || previousView?.turn?.number !== view.turn?.number
        || previousView?.turn?.active_player_id !== view.turn?.active_player_id)
      this.publicArea.clearPlayerActivity();
    const activity = playerActivity(view, previousView, events);
    if (activity) this.publicArea.showPlayerActivity(activity.playerId, activity.text);
    this.receivedView = view;
    this.syncing = true;
    try {
      const previous = this.state;
      const steps = !reset && previous && view.version === this.version + 1 ? deckTransitions(previous, snapshot.deck,
        events, view.viewer_player_id, origins) : [];
      if (steps.length) void this.deck.animateSequence(snapshot.deck, steps).catch(error => console.error('Card animation failed', error));
      else this.deck.setState(snapshot.deck, {clearSelection: reset, resetHandOrder: reset, closeBrowser: reset});
      this.state = snapshot.deck; this.matchId = view.id; this.version = view.version;
      this.eventSequence = Math.max(0, ...view.event_log.map(event => event.sequence));
    } finally {this.syncing = false;}
  }
  controls(view: MatchView, busy: boolean): void {
    this.view = view; this.busy = busy;
    const blocked = busy || this.deck.isBusy;
    this.rest.receive(view, blocked);
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
    const choices: PlayerResponseChoice[] = mayAct && view.pending_choice ? [{id: 'effect:respond', label: '处理效果', tone: 'gold'}]
      : this.rest.active ? this.rest.choices
      : this.cardActions.choices ?? (mayAct && view.turn?.subphase === 'DUNGEON_PREPARE'
        ? [{id: 'SubmitBattleTeam', label: '完成', tone: 'gold', disabled: !view.battle_preparation}]
      : mayAct && choose ? (choose.actions ?? []).map(action => ({id: `action:${action}`, label: labels[action] ?? action, tone: tones[action]}))
      : mayAct ? view.legal_commands.filter(command => command.type === 'FinishTurn')
        .map(command => ({id: command.type, label: '结束回合', tone: 'red' as const})) : []);
    const progress = actionProgress(view);
    const response: PlayerResponse = {id: `${view.id}:${view.version}`, prompt: this.rest.active ? this.rest.prompt : view.pending_choice ? '等待效果响应' : mayAct && choose ? '请选择本回合行动' : progress ? '' : phaseLabel(view.turn?.subphase),
      isCurrentTurn: view.status === 'active' && view.turn?.active_player_id === view.viewer_player_id,
      progress,
      selectedId: this.rest.active ? this.rest.selectedId : this.cardActions.selectedId, choices, disabled: blocked};
    this.deck.setResponse(response);
    this.deck.setHighlightedIds(this.rest.active ? this.rest.highlightedIds : this.cardActions.highlightedIds);
    this.publicArea.setPurchaseOptions(this.cardActions.purchaseOptions);
  }
  setSelected(ids: readonly string[]): void {this.selection = [...ids]; if (!this.deck.isBusy) this.deck.setSelectedIds(ids);}
  finish(): void {this.deck.finish(); this.publicArea.finish();}
  closeBrowsers(): void {this.cardActions.close(); this.deck.closeBrowser(); this.publicArea.closeBrowsers();}
  dispose(): void {this.cardActions.dispose(); this.deck.dispose(); this.publicArea.dispose();}
}
