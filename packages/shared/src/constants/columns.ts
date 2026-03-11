export const COLS = {
  GROUP: 1,
  CARD_NAME: 2,
  TYPE: 3,
  CARD_NO: 4,
  IMAGE: 5,
  RARITY: 6,
  PRICE_HIGH: 7,
  PRICE_LOW: 8,
} as const;

export const DB_COLS = {
  GROUP: 1,
  CARD_NAME: 2,
  TYPE: 3,
  CARD_NO: 4,
  IMAGE: 5,
  RARITY_ICON: 6,
  PRICE_HIGH: 7,
  PRICE_LOW: 8,
} as const;

export const SPECTRE_MAP_COLS = {
  GROUP: 1,
  SPECTRE_NAME: 2,
  SPECTRE_PRICE: 3,
  IMAGE_URL: 4,
  HARAKA_NAME: 5,
  HARAKA_TYPE: 6,
  HARAKA_CARD_NO: 7,
  BUY_PRICE: 8,
} as const;
