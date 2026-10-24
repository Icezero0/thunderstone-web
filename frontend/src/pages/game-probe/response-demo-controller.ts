import type {PlayerDeckArea} from '../../shared/components/player-deck-area/index.js';

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const controlIds = ['demo-response-action', 'demo-response-rest', 'demo-response-phase', 'demo-response-clear'] as const;

/** Scripted display examples only. No engine commands, card removal or real turn progression. */
export class ResponseDemoController {
  private mode: 'empty' | 'action' | 'rest' | 'phase' = 'empty';
  private readonly cleanup: (() => void)[] = [];
  constructor(private area: PlayerDeckArea, private blocked: () => boolean, private status: (text: string) => void) {
    const actions = [() => this.showAction(), () => this.showRest(), () => this.showPhase(), () => this.clear()];
    controlIds.forEach((id, index) => {
      const button = $(id), clicked = () => {if (!this.blocked()) actions[index]();};
      button.addEventListener('click', clicked); this.cleanup.push(() => button.removeEventListener('click', clicked));
    });
    this.updateControls();
  }
  private showAction(): void {
    this.mode = 'action';
    this.area.setResponse({id: 'turn-action', prompt: '回合开始：请选择行动', choices: [
      {id: 'village', label: '村庄'}, {id: 'dungeon', label: '地下城'}, {id: 'rest', label: '休整'},
    ]});
  }
  private showRest(): void {this.mode = 'rest'; this.renderRest();}
  private renderRest(): void {
    this.area.setResponse({id: 'rest-choice', prompt: '休整：可选择 1 张手牌摧毁，或直接结束回合。', choices: [
      {id: 'destroy', label: '摧毁选中手牌', disabled: this.area.selectedIds.length !== 1}, {id: 'end-turn', label: '结束回合'},
    ]});
  }
  private showPhase(): void {
    this.mode = 'phase'; this.area.setResponse({id: 'phase-status', prompt: '地下城准备：可使用能力并调整出战选择。'});
  }
  handleChoice(responseId: string, choiceId: string): void {
    if (this.blocked()) return;
    if (this.mode === 'action' && responseId === 'turn-action') {
      if (choiceId === 'rest') {this.showRest(); this.status('演示：进入休整提示，尚未执行游戏规则。');}
      else if (choiceId === 'village' || choiceId === 'dungeon') {
        this.clear(); this.status(`演示：已选择${choiceId === 'village' ? '村庄' : '地下城'}，行动选项已收起。`);
      }
    } else if (this.mode === 'rest' && responseId === 'rest-choice') {
      if (choiceId === 'end-turn') {this.clear(); this.status('演示：确认结束回合，响应区已清空；未实际推进回合。');}
      else if (choiceId === 'destroy' && this.area.selectedIds.length === 1) {
        this.clear(); this.status('演示：已确认摧毁选中手牌，响应区已清空；未实际移除卡牌。');
      }
    }
  }
  selectionChanged(): void {if (this.mode === 'rest') this.renderRest();}
  clear(): void {this.mode = 'empty'; this.area.setResponse(null);}
  updateControls(): void {for (const id of controlIds) $(id).disabled = this.blocked();}
  dispose(): void {this.cleanup.forEach(cleanup => cleanup());}
}
