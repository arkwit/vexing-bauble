export interface ScryfallCard {
  printing_id?: number;
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
    art_crop?: string;
  };
  prices?: {
    eur?: string | null;
    eur_foil?: string | null;
    eur_etched?: string | null;
  };
  card_faces?: {
    image_uris?: {
      normal?: string;
      small?: string;
    };
  }[];
}
