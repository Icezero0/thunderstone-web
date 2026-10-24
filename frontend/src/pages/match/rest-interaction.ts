import type {GameCommand, MatchView} from '../../shared/api/types.js';
import type {PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';

/** Local targeting UI only. The server supplies candidates and resolves destruction/end of turn. */
export class RestInteraction {
  private view: MatchView | null = null;
  private busy = false;
  private key = '';
  private selecting = false;
  constructor(private send: (command: GameCommand) => void) {}

  receive(view: MatchView, busy: boolean): void {
    const key = `${view.id}:${view.version}`;
    if (key !== this.key) {this.key = key; this.selecting = false;}
    this.view = view; this.busy = busy;
    if (!this.active) this.selecting = false;
  }
  get active(): boolean {
    const view = this.view;
    return !!view && view.status === 'active' && view.actor_player_id === view.viewer_player_id && !view.unavailable_reason
      && view.legal_commands.some(command => command.type === 'RestDestroy' || command.type === 'SkipRestDestroy');
  }
  private get candidates(): string[] {
    const view = this.view;
    return this.active ? (view!.legal_commands.find(command => command.type === 'RestDestroy')?.instance_ids ?? [])
      .filter(id => view!.hand.some(card => card.instance_id === id)) : [];
  }
  get highlightedIds(): readonly string[] {return this.selecting && !this.busy ? this.candidates : [];}
  get selectedId(): string | undefined {return this.selecting ? 'rest:destroy' : undefined;}
  get prompt(): string {return this.selecting ? '选择一张手牌摧毁' : '';}
  get choices(): PlayerResponseChoice[] {
    if (!this.active) return [];
    return [{id: 'rest:destroy', label: '摧毁手牌',
      disabled: !this.candidates.length, tone: 'gold'},
      ...(this.view!.legal_commands.some(command => command.type === 'SkipRestDestroy')
        ? [{id: 'SkipRestDestroy', label: '跳过'}] : [])];
  }
  choose(id: string): boolean {
    if (!this.active || this.busy) return false;
    if (id === 'rest:destroy' && this.candidates.length) {this.selecting = !this.selecting; return true;}
    return false;
  }
  clickHand(id: string): boolean {
    if (!this.active) return false;
    if (this.selecting && !this.busy && this.candidates.includes(id)) this.send({type: 'RestDestroy', instance_id: id});
    return true;
  }
}
