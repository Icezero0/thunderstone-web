export interface CardImageSource {front: (cardId: string) => string; back: string;}
export interface CardAttachment {readonly id: string; readonly cardId: string; readonly name: string; readonly kind: string;}
export interface CardStatus {readonly kind: 'buff' | 'debuff' | 'destroy'; readonly source_name: string;
  readonly source_card_id?: string; readonly description: string; readonly continuous?: boolean;}
