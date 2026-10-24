import {PublicTableArea} from '../../shared/components/public-table-area/index.js';
import {PlayerDeckArea, type PlayerDeckState, type PlayerResponse, type PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {tableState} from './table-state.js';
import {actionProgress, phaseLabel} from './model.js';
import {$} from './dom.js';
import {RestInteraction} from './rest-interaction.js';
import {deckTransitions} from './deck-transitions.js';
import {playerActivity} from './player-activity.js';

/** The production host of the same public table and deck components used by game-probe. */
export class MatchTable {
  private readonly publicArea: PublicTableArea;
  private readonly deck: PlayerDeckArea;
  private readonly rest: RestInteraction;
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
    target: (id: string) => void) {
    this.rest = new RestInteraction(send);
    const options = {overlayRoot: $('#match-overlays'), background: [$('#match-content'), $('#match-header')]};
    this.publicArea = new PublicTableArea($('#match-public-area'), {...options, idPrefix: 'match-public', onHallCardClick: item => {if (!this.busy) target(item.id);}});
    this.deck = new PlayerDeckArea($('#match-deck-area'), {...options, idPrefix: 'match-deck',
      onBusyChange: busy => {if (!busy && this.state) this.deck.setSelectedIds(this.selection.filter(id => this.state!.hand.some(card => card.id === id)));},
      onHandCardClick: id => this.rest.clickHand(id),
      onSelectionChange: ids => {
        if (this.syncing) return;
        if (this.busy) this.deck.setSelectedIds(this.selection.filter(id => this.state?.hand.some(card => card.id === id)));
        else this.selectHand(ids);
      },
      onResponse: (_id, id) => {
        if (this.rest.choose(id)) {
          this.deck.setActiveTab('hand'); this.setSelected([]); this.controls(this.view!, this.busy); return;
        }
        const command = this.view?.legal_commands.find(command => command.type === id);
        if (id.startsWith('action:')) this.send({type: 'ChooseAction', action: id.slice(7)});
        else if (command) this.send({type: id});
      }});
  }
  receive(view: MatchView): void {
    const snapshot = tableState(view), reset = view.id !== this.matchId;
    this.view = view; this.publicArea.setState(snapshot.table);
    if (!reset && view.version === this.version) return;
    const events = reset ? [] : view.event_log.filter(event => event.sequence > this.eventSequence);
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
        events, view.viewer_player_id) : [];
      if (steps.length) void this.deck.animateSequence(snapshot.deck, steps).catch(error => console.error('Card animation failed', error));
      else this.deck.setState(snapshot.deck, {clearSelection: reset, resetHandOrder: reset, closeBrowser: reset});
      this.state = snapshot.deck; this.matchId = view.id; this.version = view.version;
      this.eventSequence = Math.max(0, ...view.event_log.map(event => event.sequence));
    } finally {this.syncing = false;}
  }
  controls(view: MatchView, busy: boolean): void {
    this.view = view; this.busy = busy;
    this.rest.receive(view, busy);
    const mayAct = view.status === 'active' && view.actor_player_id === view.viewer_player_id && !view.unavailable_reason;
    const choose = view.legal_commands.find(command => command.type === 'ChooseAction');
    const labels: Record<string, string> = {village: '访问村庄', dungeon: '进入地下城', rest: '休整'};
    const tones: Record<string, PlayerResponseChoice['tone']> = {village: 'gold', dungeon: 'violet', rest: 'blue'};
    const choices: PlayerResponseChoice[] = this.rest.active ? this.rest.choices
      : mayAct && choose ? (choose.actions ?? []).map(action => ({id: `action:${action}`, label: labels[action] ?? action, tone: tones[action]}))
      : mayAct ? view.legal_commands.filter(command => ['FinishAbilities', 'FinishBuying', 'FinishUpgrading', 'FinishTurn'].includes(command.type))
        .map(command => ({id: command.type, label: ({FinishAbilities: '生产金币', FinishBuying: '开始升级', FinishUpgrading: '完成升级', FinishTurn: '结束回合'} as Record<string, string>)[command.type],
          tone: command.type === 'FinishTurn' ? 'red' : undefined})) : [];
    const progress = actionProgress(view);
    const response: PlayerResponse = {id: `${view.id}:${view.version}`, prompt: this.rest.active ? this.rest.prompt : view.pending_choice ? '等待效果响应' : mayAct && choose ? '请选择本回合行动' : progress ? '' : phaseLabel(view.turn?.subphase),
      isCurrentTurn: view.status === 'active' && view.turn?.active_player_id === view.viewer_player_id,
      progress,
      selectedId: this.rest.active ? this.rest.selectedId : undefined, choices, disabled: busy};
    this.deck.setResponse(response);
    this.deck.setHighlightedIds(this.rest.highlightedIds);
  }
  setSelected(ids: readonly string[]): void {this.selection = [...ids]; if (!this.deck.isBusy) this.deck.setSelectedIds(ids);}
  finish(): void {this.deck.finish(); this.publicArea.finish();}
  closeBrowsers(): void {this.deck.closeBrowser(); this.publicArea.closeBrowsers();}
  dispose(): void {this.deck.dispose(); this.publicArea.dispose();}
}
