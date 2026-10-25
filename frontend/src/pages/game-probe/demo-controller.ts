import {PlayerDeckArea} from '../../shared/components/player-deck-area/index.js';
import {createDemoState, drawDemoCards, discardDemoCards, toggleDemoTreasures, toggleDemoAside, MAX_HAND, type DemoChange, type DemoState} from './demo-state.js';
import {probeElementId} from './element-ids.js';
import {PublicAreaDemo} from './public-demo-controller.js';
import {ResponseDemoController} from './response-demo-controller.js';
import type {SupplySelection} from '../../shared/components/table-areas/index.js';
import type {User} from '../../shared/api/types.js';
import {HandSortPreference} from '../../app/hand-sort-preference.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Demo fixtures and buttons only; PlayerDeckArea owns the card UI and animations. */
export class DemoController {
  private state = createDemoState();
  private readonly area: PlayerDeckArea;
  private readonly sortPreference: HandSortPreference;
  private readonly publicAreas: PublicAreaDemo;
  private readonly responseDemo: ResponseDemoController;
  private supplyInstance = 0;
  private readonly cleanup: (() => void)[] = [];
  private readonly input = $<HTMLInputElement>('hand-count');
  private readonly batch = $<HTMLInputElement>('draw-quantity');
  private readonly status = $('demo-status');
  private disposed = false;
  private pending = false;
  private revision = 0;
  private result = '';
  private syncTimer: number | null = null;

  constructor() {
    this.area = new PlayerDeckArea($('player-deck-area'), {
      overlayRoot: $('player-deck-overlays'), background: [$('probe-shell'), $('probe-header')],
      descriptionId: 'probe-shortcuts', notice: $('probe-notice'), elementId: probeElementId,
      onSelectionChange: () => {this.updateControls(); this.responseDemo?.selectionChanged();},
      onHandOrderChange: () => {
        this.state = this.displayedState(); this.status.textContent = '已调整手牌顺序。';
      },
      onAutoSortChange: enabled => {
        this.sortPreference.change(enabled);
        this.state = this.displayedState();
        this.status.textContent = enabled ? '自动理牌已开启，手牌按卡牌 ID 排序。' : '自动理牌已关闭，可以拖动手牌调整顺序。';
      },
      onBusyChange: () => this.updateControls(),
      onResponse: (responseId, choiceId) => this.responseDemo.handleChoice(responseId, choiceId),
    });
    this.sortPreference = new HandSortPreference(enabled => this.area.setAutoSort(enabled, {notify: false}), text => {this.status.textContent = text;});
    this.responseDemo = new ResponseDemoController(this.area, () => this.blocked || this.area.isBrowsing, text => {this.status.textContent = text;});
    this.publicAreas = new PublicAreaDemo(selection => this.receiveSupply(selection));
    const resources = () => {
      const value = (id: string) => {const amount = Number($<HTMLInputElement>(id).value); return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;};
      this.area.setResources({gold: value('demo-gold'), xp: value('demo-xp')});
    };
    this.bind($('demo-gold'), 'input', resources); this.bind($('demo-xp'), 'input', resources); resources();
    this.bind(this.input, 'input', () => this.setCount(Number(this.input.value)));
    this.bind($('fewer-cards'), 'click', () => this.setCount(this.state.hand.length - 1));
    this.bind($('more-cards'), 'click', () => this.setCount(this.state.hand.length + 1));
    this.bind($('draw-one'), 'click', () => {void this.move(drawDemoCards(this.displayedState(), 1), 'draw');});
    this.bind($('draw-many'), 'click', () => {
      const quantity = Math.max(1, Math.min(30, Math.trunc(Number(this.batch.value)) || 1));
      this.batch.value = String(quantity); void this.move(drawDemoCards(this.displayedState(), quantity), 'draw');
    });
    this.bind($('discard-selected'), 'click', () => {
      void this.move(discardDemoCards(this.displayedState(), new Set(this.area.selectedIds)), 'discard');
    });
    this.bind($('discard-all'), 'click', () => {
      void this.move(discardDemoCards(this.displayedState(), new Set(this.area.handOrder)), 'discard');
    });
    this.bind($('shuffle-demo'), 'click', () => {void this.showShuffle();});
    this.bind($('destroy-demo'), 'click', () => {void this.showDestruction();});
    this.bind($('upgrade-demo'), 'click', () => {void this.showUpgrade();});
    this.bind($('reset-demo'), 'click', () => {this.finish(); this.reset(6); this.publicAreas.resetSupplies();});
    this.bind($('test-draw-sync'), 'click', () => this.testPileSync('draw'));
    this.bind($('test-discard-sync'), 'click', () => this.testPileSync('discard'));
    this.bind($('demo-treasures'), 'click', () => this.toggleAuxiliary('treasures'));
    this.bind($('demo-aside'), 'click', () => this.toggleAuxiliary('aside'));
    window.addEventListener('blur', this.finish);
    document.addEventListener('visibilitychange', this.visibility);
    this.area.setState(this.state, {clearSelection: true, resetHandOrder: true}); this.updateControls();
  }

  setProfile(user: User | null): void {if (!this.disposed) {this.publicAreas.setProfile(user); this.sortPreference.receive(user);}}
  private get blocked(): boolean {return this.area.isBusy || this.disposed;}
  private bind(element: HTMLElement, type: string, callback: () => void): void {
    element.addEventListener(type, callback); this.cleanup.push(() => element.removeEventListener(type, callback));
  }
  private displayedState(): DemoState {
    const byId = new Map(this.state.hand.map(card => [card.id, card]));
    return {...this.state, hand: this.area.handOrder.map(id => byId.get(id)!).filter(Boolean)};
  }
  private setCount(count: number): void {if (!this.blocked && !this.area.isBrowsing) this.reset(count);}
  private reset(count: number): void {
    this.cancelSyncTest();
    ++this.revision; this.pending = false; this.result = ''; this.state = createDemoState(count);
    this.area.setState(this.state, {clearSelection: true, resetHandOrder: true, closeBrowser: true});
    this.responseDemo.clear();
    this.status.textContent = '点击手牌可选中，再点击“弃选中”。'; this.updateControls();
  }
  private toggleAuxiliary(kind: 'treasures' | 'aside'): void {
    if (this.blocked || this.area.isBrowsing) return;
    this.cancelSyncTest();
    this.state = kind === 'treasures' ? toggleDemoTreasures(this.displayedState()) : toggleDemoAside(this.displayedState());
    this.area.setState(this.state);
    this.status.textContent = kind === 'treasures' ? (this.state.treasures?.length ? '已演示获得宝藏，宝藏 Tab 已出现。' : '已清空宝藏，宝藏 Tab 已隐藏。')
      : this.state.aside?.length ? '已演示旁置手牌，旁置 Tab 已出现。' : '旁置牌已返回手牌。';
    this.updateControls();
  }
  private updateControls(): void {
    const count = this.state.hand.length, cannotDraw = this.blocked || !this.state.draw.length || count >= MAX_HAND;
    this.input.value = String(count); this.input.disabled = this.blocked;
    this.input.setAttribute('aria-valuetext', `${count} 张手牌`);
    $('hand-count-label').textContent = `${count} 张`;
    $<HTMLButtonElement>('fewer-cards').disabled = this.blocked || count === 0;
    $<HTMLButtonElement>('more-cards').disabled = this.blocked || count === MAX_HAND;
    $<HTMLButtonElement>('draw-one').disabled = cannotDraw;
    $<HTMLButtonElement>('draw-many').disabled = cannotDraw; this.batch.disabled = this.blocked;
    const selected = $<HTMLButtonElement>('discard-selected'), selectedCount = this.area.selectedIds.length;
    selected.disabled = this.blocked || !selectedCount;
    selected.textContent = selectedCount ? `弃选中（${selectedCount}）` : '弃选中';
    $<HTMLButtonElement>('discard-all').disabled = this.blocked || count === 0;
    $<HTMLButtonElement>('shuffle-demo').disabled = this.blocked || !this.state.draw.length && !this.state.discard.length;
    $<HTMLButtonElement>('destroy-demo').disabled = this.blocked || count === 0;
    $<HTMLButtonElement>('upgrade-demo').disabled = this.blocked || !this.state.hand.some(card => ['TS-0336', 'TS-0337'].includes(card.cardId));
    $<HTMLButtonElement>('test-draw-sync').disabled = this.blocked;
    $<HTMLButtonElement>('test-discard-sync').disabled = this.blocked;
    const treasures = $<HTMLButtonElement>('demo-treasures'), aside = $<HTMLButtonElement>('demo-aside');
    treasures.disabled = this.blocked; treasures.textContent = this.state.treasures?.length ? '清空宝藏' : '演示获得宝藏';
    aside.disabled = this.blocked || !count && !this.state.aside?.length;
    aside.textContent = this.state.aside?.length ? '归还旁置牌' : '演示旁置';
    this.responseDemo?.updateControls();
    $('probe-table').setAttribute('aria-busy', String(this.area.isBusy));
    if (!this.disposed) this.publicAreas?.setOwnCards(this.state);
  }
  private async move(change: DemoChange, kind: 'draw' | 'discard'): Promise<void> {
    if (this.blocked || this.area.isBrowsing || !change.moved.length) return;
    this.cancelSyncTest();
    const generation = ++this.revision; this.pending = true; this.state = change.state;
    this.result = `已${kind === 'draw' ? '抽取' : '弃掉'} ${change.moved.length} 张牌。`;
    this.status.textContent = `正在${kind === 'draw' ? '抽牌' : '弃牌'}…`;
    try {await this.area.animateTo(this.state, {kind, instanceIds: change.moved.map(card => card.id)});}
    finally {
      if (generation === this.revision && !this.disposed) {
        this.pending = false; this.status.textContent = this.result; this.updateControls();
      }
    }
  }
  private async showShuffle(): Promise<void> {
    if (this.blocked || this.area.isBrowsing) return;
    this.cancelSyncTest();
    const source = [...this.state.draw, ...this.state.discard]; if (!source.length) return;
    const generation = ++this.revision; this.pending = true;
    // This fixture belongs to the probe. The component only animates the supplied transfer.
    this.state = {...this.displayedState(), draw: [], discard: source};
    this.area.setState(this.state, {clearSelection: true});
    this.state = {...this.state, draw: source, discard: []};
    this.result = `已演示 ${source.length} 张牌洗回抽牌堆。`;
    this.status.textContent = '演示：抽牌堆为空，正在洗回弃牌堆…';
    try {await this.area.shuffleTo(this.state);}
    finally {
      if (generation === this.revision && !this.disposed) {
        this.pending = false; this.status.textContent = this.result; this.updateControls();
      }
    }
  }
  private async showDestruction(): Promise<void> {
    if (this.blocked || this.area.isBrowsing) return;
    const before = this.displayedState(), victim = before.hand.find(card => this.area.selectedIds.includes(card.id)) ?? before.hand[0];
    if (!victim) return;
    this.cancelSyncTest(); this.area.setActiveTab('hand');
    const generation = ++this.revision; this.pending = true;
    this.state = {...before, hand: before.hand.filter(card => card.id !== victim.id)};
    this.result = `已演示摧毁${victim.name}。`; this.status.textContent = '正在演示卡面化为尘埃…';
    try {await this.area.destroyTo(this.state, [victim.id]);}
    finally {
      if (generation === this.revision && !this.disposed) {
        this.pending = false; this.status.textContent = this.result; this.updateControls();
      }
    }
  }
  private async showUpgrade(): Promise<void> {
    if (this.blocked || this.area.isBrowsing) return;
    const before = this.displayedState(), eligible = before.hand.filter(card => ['TS-0336', 'TS-0337'].includes(card.cardId));
    const source = eligible.find(card => this.area.selectedIds.includes(card.id)) ?? eligible[0];
    if (!source) return;
    this.cancelSyncTest(); this.area.setActiveTab('hand');
    const generation = ++this.revision; this.pending = true;
    const target = {id: `upgrade-demo-${++this.supplyInstance}`, cardId: source.cardId === 'TS-0336' ? 'TS-0337' : 'TS-0338',
      name: source.cardId === 'TS-0336' ? '猎法者烈焰' : '猎法者凶刃'};
    this.state = {...before, hand: before.hand.filter(card => card.id !== source.id), discard: [...before.discard, target]};
    this.result = `已演示${source.name}升级为${target.name}。`; this.status.textContent = '正在演示英雄进化…';
    try {await this.area.animateSequence(this.state, [{kind: 'upgrade', sourceInstanceId: source.id, targetInstanceId: target.id, state: this.state}]);}
    finally {
      if (generation === this.revision && !this.disposed) {
        this.pending = false; this.status.textContent = this.result; this.updateControls();
      }
    }
  }
  /** Simulate a remote snapshot while browsing, without introducing game rules into the component. */
  private testPileSync(kind: 'draw' | 'discard'): void {
    if (this.blocked || this.area.isBrowsing) return;
    this.cancelSyncTest();
    if (this.state[kind].length < 2) this.reset(this.state.hand.length);
    this.area.openPileBrowser(kind);
    this.status.textContent = '同步测试：2 秒后模拟外部移走 2 张牌，再过 2 秒放回。';
    const before = this.displayedState();
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      if (!this.area.isBrowsing) {this.status.textContent = '同步测试已取消。'; return;}
      const moved = kind === 'draw' ? before.draw.slice(0, 2) : before.discard.slice(-2);
      this.state = kind === 'draw'
        ? {...before, draw: before.draw.slice(2), discard: [...before.discard, ...moved]}
        : {...before, discard: before.discard.slice(0, -2), draw: [...moved, ...before.draw]};
      this.area.setState(this.state);
      this.status.textContent = '已模拟外部移走 2 张牌，浏览视窗同步更新。';
      this.syncTimer = window.setTimeout(() => {
        this.syncTimer = null;
        // Do not restore old demo data if the user has already left this scenario.
        if (!this.area.isBrowsing) {this.status.textContent = '同步测试已取消。'; return;}
        this.state = before; this.area.setState(this.state);
        this.status.textContent = '同步测试完成：移走和放回均已同步。'; this.updateControls();
      }, 2000);
    }, 2000);
  }
  private cancelSyncTest(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }
  private receiveSupply(selection: SupplySelection): boolean {
    if (this.blocked) return false;
    this.cancelSyncTest();
    const card = {id: `supply-demo-${++this.supplyInstance}`, cardId: selection.cardId, name: selection.name};
    this.state = {...this.displayedState(), discard: [...this.state.discard, card]}; this.area.setState(this.state);
    this.status.textContent = `已演示取得${selection.name}，放入弃牌堆。`; this.updateControls(); return true;
  }
  finish = (): void => {
    this.area.finish(); this.publicAreas.finish(); if (this.pending) this.status.textContent = this.result; this.updateControls();
  };
  private visibility = (): void => {if (document.hidden) this.finish();};
  dispose(): void {
    if (this.disposed) return;
    this.cancelSyncTest();
    this.finish(); this.sortPreference.dispose(); this.responseDemo.dispose(); this.publicAreas.dispose(); this.area.dispose(); this.disposed = true; ++this.revision;
    this.cleanup.forEach(cleanup => cleanup());
    window.removeEventListener('blur', this.finish); document.removeEventListener('visibilitychange', this.visibility);
  }
}
