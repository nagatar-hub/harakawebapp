# 買取表レイアウト可変化プラン

## 目的

買取表の 1 ページを「固定 8×5＝40 枠」1 種類で生成している現状を変更し、**タグから導出したグループ枚数に応じて最適な枠数のレイアウトテンプレートを自動選択**できるようにする。

> 例：タグ「ピカチュウ」の有効カードが 5 枚 → 「6 枠（例：3×2）」のレイアウトを選ぶ。

---

## 現状整理（コード読み込み結果）

### データモデル

| テーブル | 役割 | 関連カラム |
|---|---|---|
| `asset_profile` | 商材（franchise）×店舗（store）ごとに **1 件** のレイアウト | `template_image`, `card_back_image`, `grid_cols`, `grid_rows`, `total_slots`, `img_width`, `img_height`, `layout_config JSONB`, `rarity_icons` |
| `rule` | タグ → 振り分け動作（isolate/merge/exclude/group） | `franchise`, `tag_pattern`, `match_type`, `behavior`, `priority`, `group_key` |
| `prepared_card` | 有効カード（タグ・価格付き） | `tag`, `price_high`, `price_low` |
| `generated_page` | 生成済みページ（1 ページ＝最大 total_slots 枚） | `page_index`, `page_label`, `card_ids[]`, `image_key`, `image_url` |

`asset_profile.layout_config` JSONB には以下が同居している：

- グリッド座標（`startX`, `colWidth`, `cardWidth`, `cardHeight`, `rows[]`, `priceBoxWidth/Height`, `dateX/Y`, レアリティアイコンの相対位置）
- Drive ID（`templateFileId`, `templateFileId_BOX`, `cardBackId`, `cardBackId_BOX`, `outputFolderId`）
- 行ごとの Y 座標（`rows[].cardY`, `priceHighY`, `priceLowY`）— **5 行分ハードコード**

### 画像生成パイプライン

```
sync.ts   : タグ付け → planPages(validCards, rules, profile.total_slots) → generated_page insert
generate.ts: generated_page 再プラン → ページごとに composePage() → Storage upload
regenerate-page.ts: 単ページ再合成（価格/画像 URL 修正時）
```

### ページ分割アルゴリズム（`page-planner.ts`）

1. `rules` を priority 降順で適用（`isolate` / `exclude` / `merge` / `group`）
2. マッチしたカードを `splitIntoGroupedPages(cards, totalSlots)` で分割
3. 残りカードはメインタグでグルーピング → **FFD ビンパッキング** で `totalSlots` 単位に詰める
4. どのパスも `totalSlots`（= 40）を 1 ページ上限として扱う

### 現状の BOX 特殊処理

- `label === 'BOX'` のページは `layout_config.templateFileId_BOX` の別 PNG を使用
- ただし **枠数は 40 のまま**、`skipPriceLow=true` で青値を非表示にするだけ
- `generate.ts` / `regenerate-page.ts` 両方でハードコード判定

### 行微調整の所在（重要）

`generate.ts:304-317` と `regenerate-page.ts:206-219` に、**franchise ごとの行別 Y オフセット**（`layoutAdjust`, `rowPriceAdjust`, `rowCardAdjust`）がハードコードされている。これは現状 5 行固定に合わせた値で、新しいレイアウト（2×3 など）では成立しない。

---

## 設計方針

### コア設計：`layout_template` テーブルを新設

`asset_profile.layout_config` に直接複数レイアウトを詰めるのではなく、**1:N の別テーブル** として切り出す。理由：

- 1 franchise × N レイアウト（3 枠〜40 枠など複数）
- 管理画面から個別に追加・削除・有効無効を切り替えやすい
- テンプレ PNG ・行座標が **1 レイアウトに完結**
- ハードコード行オフセットをレイアウト定義に取り込める（refactor のチャンス）

```
layout_template
├── id (uuid, PK)
├── store (text)                   -- "oripark" など
├── franchise (text)               -- "Pokemon" | "ONE PIECE" | "YU-GI-OH!"
├── name                           -- 「6枠 (3x2)」「40枠 (8x5)」「BOX 40枠」など
├── slug                           -- "grid_3x2", "grid_8x5", "box_8x5"
├── grid_cols (int)
├── grid_rows (int)
├── total_slots (int)              -- grid_cols * grid_rows
├── img_width / img_height (int)
├── template_storage_path (text)   -- Supabase Storage のパス（例: "templates/pokemon/20.png"）
├── card_back_storage_path (text)  -- カード裏面の Storage パス
├── layout_config (jsonb)          -- startX, colWidth, cardWidth, rows[], priceBox*, dateX/Y, rarityIcon*, rowCardAdjust, rowPriceAdjust
├── skip_price_low (bool)          -- BOX ページ等で青値非表示
├── is_default (bool)              -- 既定レイアウト（グループがどのレイアウトにも収まらないときのフォールバック）
├── is_active (bool)
├── priority (int)                 -- 同サイズ候補が複数ある時の優先度
├── created_at / updated_at
└── UNIQUE(store, franchise, slug)
```

`asset_profile` 側は**テンプレ PNG / layout_config を廃止**（もしくはデフォルト参照のみ残す）し、レイアウト定義は `layout_template` に完全移行。互換のため Phase 1 では両方に残す。

### アセット配置：Supabase Storage 一本化（Q9）

`haraka-images` バケット内を以下の構造に：

```
haraka-images/
├── generated/YYYY/MM/DD/{franchise}/page_N.png    # 既存（生成ページ出力）
├── templates/
│   ├── pokemon/
│   │   ├── 1.png, 2.png, 4.png, 6.png, 9.png, 15.png, 20.png, 40.png
│   │   └── box_40.png
│   ├── onepiece/
│   │   └── （同上）
│   └── yugioh/
│       └── （同上）
├── card-backs/
│   ├── pokemon.png
│   ├── onepiece.png
│   └── yugioh.png
└── rarity-icons/
    ├── SAR.png
    ├── SR.png
    └── ...（RarityIcons シートから移行）
```

既存の RarityIcons シート（Google Sheet）との関係：

- **今回: Supabase Storage ＋ DB テーブル `rarity_icon` を正とする**
- シート側は過渡期に参照を残すが、最終的には廃止
- 新テーブル：

```
rarity_icon
├── id (uuid, PK)
├── franchise (text, nullable)    -- 共通アイコンは NULL
├── name (text)                   -- "SAR", "SR", "UR" 等
├── storage_path (text)           -- "rarity-icons/SAR.png"
├── drive_id (text, nullable)     -- 互換用（フォールバック）
└── UNIQUE(franchise, name)
```

### アセット取得 API の統一

`packages/job/src/lib/asset-storage.ts`（新規）を用意し、以下 2 つの関数を提供：

```ts
async function downloadFromStorage(supabase, path: string): Promise<Buffer>
async function uploadToStorage(supabase, path: string, buffer: Buffer): Promise<void>
```

`generate.ts` / `regenerate-page.ts` からの `downloadDriveFile(accessToken, ...)` 呼び出しを段階的に `downloadFromStorage(supabase, path)` に置換する。

### 選択アルゴリズム（`selectLayout`）

`planPages` 内、または後続のレイアウト割当工程で、各「ページ候補（= bin）」ごとに：

```ts
function selectLayout(cardCount: number, candidates: LayoutTemplate[]): LayoutTemplate
```

ポリシー候補：

- **A. ぴったり or 最小の超過枠（推奨）**  
  `min over { layout | layout.total_slots >= cardCount }`  
  ＝「5 枚なら 6 枠」「9 枚なら 12 枠」「20 枠ちょうどなら 20 枠」
- **B. 充填率閾値つき**  
  A を基本とし、充填率が 50% を切る組合せは「1 つ大きい候補」を試す等
- **C. 最大枠超過時**  
  `cardCount > max(total_slots)` の場合は **最大枠レイアウト** で分割（現状踏襲）

→ **まずは A** を実装。B/C は閾値調整で後付け可能。

### ページ分割（`page-planner.ts`）の修正

現状：FFD ビンパッキングで複数タググループを 40 枠に詰める。

新仕様：

1. **isolate / merge / group ルール** でまとまったカード群 → **そのグループだけを selectLayout に投げて単一レイアウトで出力**（=「タグ別ページに最適枠」）
2. **一般（その他）カード群** → 以下 2 案を検討：
   - **案 X（シンプル）**: 従来どおりデフォルトレイアウト（通常 40 枠）で FFD ビンパッキング
   - **案 Y（全面最適化）**: メインタグ単位でさらにグループ分けしてから selectLayout を適用
3. グループが最大枠を超える場合 → 最大枠レイアウトで分割

→ **案 X を推奨**。「タグで括られた特集ページは最適枠」「その他は従来どおり 40 枠ビンパッキング」のほうが利用者の意図に近く、既存の「その他ページ」の見た目を維持できる。

### 合成処理（`image-composer.ts`）

現在は引数で `layout: LayoutConfig`, `assetProfile: AssetProfileRow`, `totalSlots` を受け取る。  
→ `layout_template` から単一の `RenderingLayout` を作って渡す形に統一：

```ts
interface RenderingLayout {
  templateBuffer: Buffer;
  cardBackBuffer: Buffer;
  gridCols: number;
  gridRows: number;
  totalSlots: number;
  layoutConfig: LayoutConfig;   // rows[], offsets, etc.
  skipPriceLow: boolean;
  layoutAdjust?: { cardYDelta, priceYDelta };
  rowPriceAdjust?: Record<number, ...>;
  rowCardAdjust?: Record<number, number>;
}
```

これにより `generate.ts` のハードコード franchise 判定も削除可能。

### generated_page の追加カラム

どのレイアウトで生成したかを記録して再生成で再利用できるようにする：

```sql
ALTER TABLE generated_page ADD COLUMN layout_template_id uuid REFERENCES layout_template(id);
```

`regenerate-page.ts` は `layout_template_id` を読んで同じテンプレを使う。

### 管理 UI（段階的）

- **Phase 1**: UI なし。seed / SQL / JSON 直編集でレイアウト登録。
- **Phase 2**: `/layouts` ページを追加し、一覧・複製・プレビュー（テンプレ PNG にダミー枠を重ねる SVG）程度。
- **Phase 3**: 座標をドラッグで調整できる簡易エディタ（大きめ）。Phase 2 まで様子見。

---

## 実装ロードマップ

### Phase 0: データモデル（マイグレーション）

1. `layout_template` テーブル作成 migration
2. `rarity_icon` テーブル作成 migration
3. `generated_page.layout_template_id` 追加 migration
4. Shared types (`database.ts`) に `LayoutTemplateRow` / `RarityIconRow` など追加
5. `layout-selector` 単体テストの骨格

### Phase 1: アセット移行スクリプト（Drive → Supabase Storage）

**目的**：Drive 依存を外し、全テンプレ・カード裏面・レアリティアイコンを Supabase Storage に一括アップロードする。1 回限りのバッチスクリプト。

1. `packages/job/src/scripts/migrate-assets-to-storage.ts` 新規作成
   - 既存 `asset_profile` / RarityIcons シートから Drive ID を列挙
   - `downloadDriveFile` で既存 Drive 資産を取得 → `haraka-images` バケットへアップロード
   - `asset_profile` の `template_image` / `card_back_image` / BOX 用 ID を新カラム（後述）に書き戻し
   - RarityIcons の内容を `rarity_icon` テーブルに挿入
2. 新規 21 PNG（ユーザ提供のローカルファイル）を同バケット下 `templates/{franchise}/{N}.png` にアップロード（別スクリプト `upload-new-layout-templates.ts`）
3. `asset_profile` に `template_storage_path`, `card_back_storage_path`, `template_box_storage_path`, `card_back_box_storage_path` カラムを追加する migration（Drive ID カラムは当面残す＝フォールバック）
4. スクリプト冪等性：既存ファイルがあれば上書き（`upsert: true`）

### Phase 2: 座標自動検出＋ layout_template 投入

1. `packages/job/src/scripts/detect-layout-slots.ts` 新規作成
   - 入力：Supabase Storage のテンプレ PNG パス（or ローカル PNG）
   - 処理：sharp で黒画素抽出 → 連結成分ラベリング → 矩形候補抽出 → 面積・アスペクト比でフィルタ
   - 出力：layout_config JSON（`rows[]`, `priceBoxWidth`, `priceBoxHeight`, `cardWidth`, `cardHeight`, `startX`, `priceStartX`, `colWidth`, `dateX/Y`）
   - デバッグ用に検出結果を可視化した PNG（赤枠で矩形、青点でカード予測位置）を同時出力
2. `packages/job/src/scripts/seed-layout-templates.ts` 新規作成
   - 21 レイアウト × 3 franchise 分の `layout_template` レコードを INSERT
   - 既存 40 枠／BOX 40 枠も移行登録（`asset_profile.layout_config` から変換）
3. 目視チェック：可視化 PNG をすべて確認し、必要に応じて検出閾値を調整

### Phase 3: レイアウト選択ロジック

1. `packages/job/src/lib/layout-selector.ts` 新規（`selectLayoutCombination`）
2. `page-planner.ts` を拡張
   - `isolate` / `group` / `merge` に加え、「その他」プールも **メインタグ単位で独立に** `selectLayoutCombination` 適用
   - 旧 FFD（タグ跨ぎ同居）を削除
   - `PagePlan` に `layout_template_id` を追加
3. `sync.ts` でプラン生成時に `layout_template_id` を `generated_page` に保存

### Phase 4: 合成パイプラインの統合

1. `packages/job/src/lib/asset-storage.ts` 新規（`downloadFromStorage` 等）
2. `image-composer.ts` を `RenderingLayout` 受け取り形にリファクタ
3. `generate.ts` / `regenerate-page.ts` を：
   - テンプレ・カード裏面を Supabase Storage から取得（Drive フォールバック付き）
   - ページごとに `layout_template_id` を読んで対応レイアウトで合成
   - franchise 分岐と `layoutAdjust` / `rowPriceAdjust` / `rowCardAdjust` のハードコードを撤去（各 `layout_template.layout_config` に埋め込まれた値を使用）
4. BOX 判定：`isBOX` 判定は残すが、BOX 用テンプレも Supabase Storage 参照に統一

### Phase 5: 疎通・E2E 確認

1. dev 環境で sync → generate を通し、以下をスクショ＋目視：
   - 5 枚グループ → `[1, 4]` で生成される
   - 11 枚グループ → `[2, 9]` で生成される
   - 62 枚グループ → `[2, 20, 40]` で生成される
   - 既存 40 枠ページが見た目変わらず（回帰なし）
2. 失敗ページが無いこと・`generated_page` に `layout_template_id` が全行 set されていること

### Phase 6（任意・別タスク）: Drive 完全切り離し

1. `packages/job/src/lib/google-drive.ts` の `downloadDriveFile` を、テンプレ・カード裏面・レアリティアイコン用途では呼ばない
2. `asset_profile.template_image`, `card_back_image` 等の Drive ID カラムを DROP
3. OAuth トークンの必要スコープを縮小（Drive scope 撤去）

---

## 決定事項（確定）

| # | 論点 | 決定 |
|---|---|---|
| Q1 | 候補枠数 | **`{1, 2, 4, 6, 9, 15, 20, 40}`** で確定。1/2/4/6/9/15/20 はユーザ提供の新規テンプレ PNG（`C:\Users\nagat\Downloads\買取表複数フォーマットオリパーク\`）、40 は既存テンプレ流用。各 franchise（ポケカ／遊戯王／ONE PIECE）ごとに 7 種類 × 3 商材 = 21 PNG |
| Q2 | 適用範囲 | **全ページに適用**（isolate/merge/group／その他、どちらもマルチレイアウト選択） |
| Q3 | フィットポリシー | カードが不自然にトリミングされないこと・価格枠とバランスが取れていることがレイアウト設計側の前提。アルゴリズムは「オーバーシュート最小 → ページ数最小」（後述） |
| Q4 | BOX の扱い | **今回は対象外**。BOX ページは現行コード（`isBOX` 判定 + `templateFileId_BOX`）をそのまま残す。ただし **テンプレ PNG は Supabase Storage 化の対象に含む**（Drive 非依存化のため） |
| Q5 | 行微調整 | Phase 2 で `layout_template.layout_config` へ移管（`generate.ts` / `regenerate-page.ts` のハードコード撤去） |
| Q6 | 管理 UI | 今回は作らない。seed / migration / SQL 直編集のみ |
| Q7 | グリッド | 均一グリッド（`grid_cols × grid_rows`）のみ |
| Q8 | `asset_profile.layout_config` | **一本化を目指す**。Phase 2 完了時点で既存の JSONB は `layout_template` から参照する最小情報（デフォルト template_id）のみ残し、位置情報は全て `layout_template` に集約 |
| Q9 | 静的アセットの置き場所 | **全テンプレ画像を Supabase Storage に移行**。Drive 非依存化。対象：① 新規 21 レイアウト PNG、② 既存 40 枠テンプレ PNG、③ BOX 用テンプレ PNG、④ カード裏面 PNG、⑤ レアリティアイコン PNG。カード画像本体（Haraka DB シート経由）は Drive のままで OK |
| Q10 | 座標抽出方式 | **自動検出**。「白＋水色／黒枠囲い」の価格ボックス矩形を検出し、`priceHighY`（白帯）／`priceLowY`（水色帯）を算出。カード位置は既存 Pokemon 40 枠の比率から導出 |

---

## 複数レイアウト組合せアルゴリズム（Q2 全適用・追加仕様）

### 要件

N 枚のカード群を、候補枠数 L の多重集合 `{l1, l2, ...}` で埋める。次の順で最適化：

1. **sum(choice) ≥ N** かつ **sum(choice) - N（= 余剰枠）が最小**
2. **|choice|（= 生成ページ数）が最小**
3. 結果を **昇順ソート**して、**小さいレイアウトから順に高価格カードを詰める**

### 優先順位

1. **オーバーシュート（余剰）最小**：`sum(choice) - N` が最小
2. **ページ数最小**：`|choice|` が最小
3. **辞書順最小（昇順ソート時）**：ページ数も同じなら、小さいレイアウトが含まれる組合せを優先（例：`[2,6]` > `[4,4]` という意味で `[2,6]` が勝つ）

ユーザ例で検算（`L = {1, 2, 4, 6, 9, 15, 20, 40}`）：

| N | 結果 | 検証 |
|---|---|---|
| 1  | `[1]` | exact / 1 page |
| 3  | `[1, 2]` | exact / 2 pages |
| 5  | `[1, 4]` | exact / 2 pages |
| 7  | `[1, 6]` | exact / 2 pages |
| 8  | `[2, 6]` | `[4,4]` と同サイズだが lex で `[2,6]` 勝ち ✓ |
| 11 | `[2, 9]` | 「15 じゃなくて 9」← ✓ |
| 13 | `[4, 9]` | ✓ |
| 17 | `[2, 15]` | ✓ |
| 41 | `[1, 40]` | exact / 2 pages |
| 62 | `[2, 20, 40]` | exact / 3 pages ← ピカチュウ 62 枚の例 ✓ |
| 100 | `[20, 40, 40]` | exact / 3 pages |

### 擬似コード（`layout-selector.ts`）

```ts
function selectLayoutCombination(
  N: number,
  layouts: LayoutTemplate[],   // 候補（slot 数・is_active な物）
): LayoutTemplate[] {
  const sizes = [...new Set(layouts.map(l => l.total_slots))].sort((a,b) => a - b);
  const maxSlot = Math.max(...sizes);
  const upper = N + maxSlot;   // 余剰はたかだか maxSlot まで

  // dp[s] = 合計 s を作る最小ページ数の組合せ（null なら不可）
  const dp: (number[] | null)[] = new Array(upper + 1).fill(null);
  dp[0] = [];

  for (let s = 1; s <= upper; s++) {
    for (const v of sizes) {
      if (s < v || dp[s - v] === null) continue;
      const cand = [...dp[s - v]!, v];
      if (dp[s] === null || cand.length < dp[s]!.length) dp[s] = cand;
    }
  }

  // N 以上で最小の s を探索（= 余剰最小）
  for (let s = N; s <= upper; s++) {
    if (dp[s] !== null) return mapToLayouts(dp[s]!.sort((a,b)=>a-b), layouts);
  }
  // フォールバック（候補が無いなど）
  return [pickLargest(layouts)];
}
```

### ページ振り分け

1. グループ内のカードを `price_high` 降順（既存の `splitIntoGroupedPages` と同じ順序）でソート
2. `selectLayoutCombination(N, layouts)` の結果（昇順）に沿って、先頭から **小さいレイアウトに先に詰める**
   - 例：N=11, combo=`[2,9]` → カード ①② を 2 枠ページへ、③〜⑪ を 9 枠ページへ
3. 生成される `generated_page` の `page_index` 順も **昇順（小さいレイアウトが先）**
4. `page_label` は従来のルール（isolate なら `tag_pattern`、その他は `メインタグ + 丸数字`）を踏襲

### 「全ページ適用」下のグルーピング方針

ユーザのご判断により、以下で確定：

- **タグなしカードは基本的に発生しない** 前提。万一出たら 40 枠フォールバックで旧挙動
- **タグ跨ぎのまとめ**は既存の `rule.behavior = 'group' + group_key` 機能に一任
  - 例：`25th_XY_BWR` グループ = `25th` / `XY` / `M進化EX` / `BWR` タグを 1 つの塊として扱う
  - 例：`SAR_AR` グループ = `SAR` / `AR` を 1 つの塊
  - これらは web UI（`/tags` 画面）で既に編集可能なため、今回追加開発は不要
- **各グループ（isolate / group / merge 全て）を独立に `selectLayoutCombination` にかける**
  - グループ内カードを `price_high` 降順でソート
  - 小さいレイアウトから順に上位カードを割り当て
- **現状の FFD（タグ跨ぎで 1 ページ同居）は撤去**

結果：`25th_XY_BWR` グループが 62 枚なら `[2, 20, 40]` に分解され、最高額 2 枚（`25th` 由来でも `メガシンカex` 由来でも価格が高い方）が 2 枠ページで spotlight される。

---

## 決定事項の影響で変わる設計ポイント

- **Q4（BOX 据え置き）**: `rule` に `layout_template_slug` は追加しない。`isBOX` 判定と `templateFileId_BOX` 参照は現状維持。BOX 以外（カードページ）のみ `layout_template` 切替を適用する
- **Q8（一本化）**: `asset_profile.layout_config` のうち座標系情報は移管対象。`rarity_icons`、`template_image`（BOX 用に必要なので）、`card_back_image`、`font_family`、`price_format`、`img_width/height` は `asset_profile` に残す。Phase 2 完了時に `asset_profile.layout_config` / `grid_cols` / `grid_rows` / `total_slots` は `layout_template` のデフォルトを参照するだけに縮小

---

## 影響範囲（ファイル一覧）

**新規作成**
- `supabase/migrations/` に 4 本追加
  - `layout_template` テーブル作成
  - `rarity_icon` テーブル作成
  - `generated_page.layout_template_id` 追加
  - `asset_profile` に `*_storage_path` 系カラム追加
- `packages/job/src/lib/asset-storage.ts` — Supabase Storage 読み書きユーティリティ
- `packages/job/src/lib/layout-selector.ts` — DP で最適組合せを算出
- `packages/job/src/scripts/migrate-assets-to-storage.ts` — Drive → Storage 一括移行（1 回限り）
- `packages/job/src/scripts/upload-new-layout-templates.ts` — ローカルの 21 PNG をアップ
- `packages/job/src/scripts/detect-layout-slots.ts` — 黒枠検出で座標抽出
- `packages/job/src/scripts/seed-layout-templates.ts` — `layout_template` レコード投入
- `packages/job/src/__tests__/layout-selector.test.ts` — DP のケース網羅テスト

**変更**
- `packages/shared/src/types/database.ts` — `LayoutTemplateRow`, `RarityIconRow`, `PagePlan` 拡張
- `packages/shared/src/constants/layout.ts` — 40 枠固定値は残すが、デフォルト slug 参照に置換
- `packages/job/src/lib/page-planner.ts` — DP ベースの割当へ。FFD を撤去
- `packages/job/src/lib/image-composer.ts` — `RenderingLayout` 受け取りへ
- `packages/job/src/jobs/sync.ts` — layout_template_id 保存
- `packages/job/src/jobs/generate.ts` — Storage 取得・ハードコード分岐撤去
- `packages/job/src/jobs/regenerate-page.ts` — layout_template_id 参照・Storage 取得
- `packages/job/src/__tests__/page-planner.test.ts` — 新アルゴリズムに合わせて調整
- `supabase/seed.sql` — `rarity_icon` seed は空で OK（migration スクリプトで投入）

**UI は Phase 6 以降まで手を付けない**（決定: Q6）

---

## リスクと注意点

1. **既存の本番 asset_profile 依存**（sync/generate/regenerate いずれも `layout_config` 直読み）→ Phase 2 完了まで `layout_template` が空のケースでは `asset_profile.layout_config` フォールバックを残す。
2. **行微調整ハードコードの移管**（Q5）— generate.ts と regenerate-page.ts で 2 箇所に同じオフセットがあり、ズレると見た目が変わる。移管時は**既存の 40 枠画像をバイナリ一致 or 目視比較**で回帰チェック。
3. **座標自動検出の誤検出**
   - テンプレ背景の虹色スパークル内に黒っぽい点群がある可能性 → 最小面積フィルタ（例：1000 px² 以上）・矩形度フィルタ（輪郭近似）でゴミを除外
   - 矩形の角が丸めてあると輪郭がズレる → モルフォロジー（dilate→erode）で補正
   - 検出後に **可視化 PNG（赤枠重畳）** を必ず出力し、21 枚ぶん目視チェック
4. **Supabase Storage 移行時のダウンタイム**
   - 移行中に generate が走ると片方が見つからず失敗する可能性 → 移行スクリプトは sync/generate を止めた上で実行（Cloud Run ジョブの実行停止が必要）
   - または両参照可能な期間を設けて段階切替（推奨）
5. **Drive 資産の保全**
   - 現行の Drive 上の元データは移行後も削除しない（元データはバックアップとして残す）
   - Phase 6 で Drive API スコープを外すとしても、ファイルは残す
6. **ページラベル命名規則** — 現状は「その他①」など丸数字を自動付与。タグ単位割当に変わるとラベル数が増減するので命名衝突の可能性を再点検。
7. **X 投稿機能との結合** — `post_item_asset.generated_page_id` を参照している。レイアウト変更はテーブル形状に影響しないが、投稿ツイート本文テンプレが「40 枚」等を前提にしていないか確認が必要。
8. **バケット公開設定** — `haraka-images` バケットは現状 public で `getPublicUrl` を使っている。テンプレートも public で問題ない（機密ではない）前提だが、念のため確認。

---

## 次アクション（実装に入る前の残タスク）

実装着手は **追加確認事項なし**。以下の順で進めます。

1. **Phase 0**：migration（`layout_template`, `rarity_icon`, `generated_page.layout_template_id`, `asset_profile.*_storage_path`）+ 型定義
2. **Phase 1**：アセット移行スクリプト 2 本（既存 Drive → Storage、ローカル 21 PNG → Storage）
3. **Phase 2**：座標自動検出スクリプト（黒枠検出）＋ seed スクリプト。**可視化 PNG を Phase 2 末で確認していただきます**
4. **Phase 3**：レイアウト選択アルゴリズム（DP）実装＋単体テスト
5. **Phase 4**：合成パイプラインの統合（Storage 参照・ハードコード撤去）
6. **Phase 5**：疎通・E2E・スクショで回帰確認

実装はこの PLAN ファイルに沿って進めます。確認ポイント（Phase 2 末の可視化 PNG など）で一度止まって相談させてください。
