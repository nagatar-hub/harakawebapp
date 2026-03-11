export type LayoutConfig = {
  startX: number;
  priceStartX: number;
  colWidth: number;
  cardWidth: number;
  cardHeight: number;
  isSmallCard: boolean;
  rows: RowConfig[];
  priceBoxWidth: number;
  priceBoxHeight: number;
  dateX: number;
  dateY: number;
  rarityIconOffsetX?: number;
  rarityIconOffsetY?: number;
  rarityIconWidth?: number;
  rarityIconHeight?: number;
};

export type RowConfig = {
  cardY: number;
  priceHighY: number;
  priceLowY: number;
};

export type RunStatus = 'running' | 'completed' | 'failed';
export type RuleMatchType = 'exact' | 'contains' | 'regex';
export type RuleBehavior = 'isolate' | 'merge' | 'exclude';

export type RunRow = {
  id: string;
  triggered_by: string;
  status: RunStatus;
  total_imported: number;
  total_prepared: number;
  total_image_ng: number;
  total_pages: number;
  started_at: string;
  import_done_at: string | null;
  prepare_done_at: string | null;
  plan_done_at: string | null;
  generate_done_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

export type RuleRow = {
  id: string;
  franchise: 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
  tag_pattern: string;
  match_type: RuleMatchType;
  behavior: RuleBehavior;
  priority: number;
  notes: string | null;
  created_at: string;
};

export type AssetProfileRow = {
  id: string;
  franchise: 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
  template_image: string | null;
  card_back_image: string | null;
  grid_cols: number;
  grid_rows: number;
  total_slots: number;
  img_width: number;
  img_height: number;
  font_family: string;
  price_format: string;
  layout_config: LayoutConfig | null;
  rarity_icons: Record<string, string> | null;
  created_at: string;
};

export type ImageStatus = 'unchecked' | 'ok' | 'fallback' | 'dead';
export type CardSource = 'kecak' | 'spectre' | 'manual';

export type RawImportRow = {
  id: string;
  run_id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  rarity: string | null;
  demand: number | null;
  kecak_price: number | null;
  raw_row: Record<string, unknown> | null;
  created_at: string;
};

export type PreparedCardRow = {
  id: string;
  run_id: string;
  raw_import_id: string | null;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  rarity: string | null;
  rarity_icon_url: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
  image_status: ImageStatus;
  source: CardSource;
  created_at: string;
};

export type PageStatus = 'pending' | 'generated' | 'failed';

export type GeneratedPageRow = {
  id: string;
  run_id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  card_ids: string[];
  image_key: string | null;
  image_url: string | null;
  status: PageStatus;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      run: {
        Row: RunRow;
        Insert: Partial<RunRow> & Pick<RunRow, 'triggered_by'>;
        Update: Partial<RunRow>;
        Relationships: [];
      };
      rule: {
        Row: RuleRow;
        Insert: Omit<RuleRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<RuleRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      asset_profile: {
        Row: AssetProfileRow;
        Insert: Omit<AssetProfileRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<AssetProfileRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      raw_import: {
        Row: RawImportRow;
        Insert: Omit<RawImportRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<RawImportRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      prepared_card: {
        Row: PreparedCardRow;
        Insert: Omit<PreparedCardRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<PreparedCardRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      generated_page: {
        Row: GeneratedPageRow;
        Insert: Omit<GeneratedPageRow, 'id' | 'created_at' | 'image_key' | 'image_url' | 'status'> & {
          id?: string; created_at?: string;
          image_key?: string | null; image_url?: string | null; status?: PageStatus;
        };
        Update: Partial<Omit<GeneratedPageRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
