
export interface OwnedCopy {
  id: number;
  printing_id: number;
  condition: string;
  finish: string;
  language: string;
  purchase_price: number | string | null;
  purchase_date: string | null;
  notes: string | null;
}

export interface Printing {
  id: number;
  scryfall_id: string;
  set_code: string;
  collector_number: string;
  rarity: string | null;
  image_uri: string | null;
  copies: OwnedCopy[];
}

export interface Card {
  id: number;
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  oracle_text: string | null;
  printings: Printing[];
}

