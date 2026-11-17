export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  released_at?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  finishes?: string[];
  image_uris?: {
    normal?: string;
    small?: string;
  };
  card_faces?: {
    image_uris?: {
      normal?: string;
      small?: string;
    };
  }[];
}
