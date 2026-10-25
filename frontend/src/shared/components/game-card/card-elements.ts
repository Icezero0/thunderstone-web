import type {CardElements} from './card-interaction.js';
import type {CardImageSource} from './types.js';

export const defaultCardImages: CardImageSource = {
  front: cardId => `/cards/${cardId}.png`, back: '/cards/TS-BACK-001.jpg',
};

/** Shared by hand, village, dungeon and browsing views; each card keeps fixed images. */
export function createCardElements(cardId: string, images = defaultCardImages, descriptionId?: string): CardElements {
  const span = (className: string): HTMLSpanElement => {
    const node = document.createElement('span'); node.className = className; return node;
  };
  const image = (url: string, back = false): HTMLImageElement => {
    const node = document.createElement('img'); node.src = url;
    node.width = back ? 501 : 504; node.height = 704; node.loading = 'eager'; node.draggable = false;
    node.alt = ''; return node;
  };
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'physical-card'; button.dataset.cardId = cardId;
  if (descriptionId) button.setAttribute('aria-describedby', descriptionId);
  const lift = span('card-lift'), surface = span('card-body');
  const front = span('card-face card-face-front'), back = span('card-face card-face-back');
  const frontImage = image(images.front(cardId)), backImage = image(images.back, true);
  front.append(frontImage); back.append(backImage); surface.append(front, back); lift.append(surface); button.append(lift);
  const inspection = document.createElement('div'); inspection.className = 'inspect-picture'; inspection.hidden = true;
  const largeFront = image(images.front(cardId)), largeBack = image(images.back, true);
  const statusPanel = document.createElement('aside'); statusPanel.className = 'inspect-status-panel'; statusPanel.hidden = true;
  statusPanel.setAttribute('aria-label', '当前卡牌状态');
  largeFront.alt = '卡牌正面原图'; largeBack.alt = '卡牌背面原图';
  inspection.append(largeFront, largeBack, statusPanel);
  return {button, surface, front, back, frontImage, backImage, inspection, largeFront, largeBack, statusPanel};
}
