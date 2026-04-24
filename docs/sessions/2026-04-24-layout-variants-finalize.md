# 2026-04-24 レイアウト可変化 最終調整 + 運用修正

## 概要

Phase 0〜4 まで実装済みだった「買取表レイアウト可変化」機能の最終調整と、作業中に発見された運用系の不具合修正をまとめて実施した。

## コミット一覧（このセッションで追加）

```
1d90297 feat(gallery): カード追加/削除時にページ枚数に合うテンプレへ自動切替
f96123f fix(gallery): 長いページ名で詳細ボタンが縦書きに潰れる問題
9c48bd6 fix(api): Haraka DB シート書き戻しに Secret Manager フォールバック
462feab fix(page-planner): group 内をタグ順×タグ内価格降順で並べる
9f2c408 docs(plan): DB↔Storage 不整合の恒久対策と BOX ルール未設定の TODO 追記
8321c76 fix(layout): 1 枚レイアウトのカード拡大とレアリティアイコンの連動スケール
```

6 コミット追加（セッション開始時は 11 コミット先行、push 後は all synced）。

---

## 1. レイアウト最終調整（`seed-layout-templates.ts`）

`layout_template.layout_config` を検出値からコードで上書きする方針。

### 1 枚レイアウト専用オーバーライド

検出値 (`cardY=415 / cardW=658 / cardH=919`) ではカードが小さく浮いて見えたため、バナー下〜価格ボックス上端の縦領域を最大活用する専用値に差し替え：

```ts
const SINGLE_CARD_OVERRIDE = {
  cardY: 330,       // priceHighY=1334 と 4px マージン
  cardWidth: 716,   // +9%
  cardHeight: 1000, // +9%
  startX: 262,      // (1240 - 716) / 2 で中央配置
};
```

### 2/4/6 枠の浮き解消

以前 `UPWARD_SHIFT_BY_SLOTS` で上方向シフトしていたが、カード下端と priceHighY の間にスキマが残り浮いて見えた。これを撤去し、検出値のまま使うことで **カード下端 = priceHighY** にぴったり接する配置に戻した。

### レアリティアイコンの連動スケール

検出器が常に `60x60 / offsetY=-10` を返す仕様だったため、カード拡大枠ではアイコンが相対的に小さくなる問題があった。以下の比率を 40 枠（`cardW=115 / icon=60 / offsetY=-10 / cardH=170`）に合わせた：

```ts
const RARITY_ICON_RATIO = 0.45;                // 0.522 から微調整、潰れ過ぎない最終値
const RARITY_ICON_OFFSET_Y_RATIO = -10 / 170;  // cardHeight に比例
```

各枠での実寸（YU-GI-OH! 基準）：
| slug | cardW×H | rarity | offsetY |
|---|---|---|---|
| grid_1x1 | 716×1000 | 322×322 | -59 |
| grid_2x1 | 484×676 | 218×218 | -40 |
| grid_2x2 | 307×429 | 138×138 | -25 |
| grid_3x2 | 315×440 | 142×142 | -26 |
| grid_3x3 | 218×305 | 98×98 | -18 |
| grid_5x3 | 206×288 | 93×93 | -17 |
| grid_5x4 | 165×230 | 74×74 | -14 |
| grid_8x5 | 115×170 | 60×60 | -10（40 枠・既存維持） |

### 新テンプレート反映

ユーザーから提供された新しい 1 枚ひな形（PSA10 買取表の文字を上に移動、価格ボックスを中央寄せ）を 3 franchise 分 `templates/{slug}/1.png` に上書きアップロード → `detect-layout-slots.ts` で再検出（`priceStartX=325 → 290`） → seed 実行。

---

## 2. page-planner: group 内のタグ順・価格順修正

### 問題

`rule.behavior='group'` で複数タグを 1 グループに集約したとき、`assignGroupToLayouts` が全カードを一括価格降順ソートしていたため、40 枠ページ内でタグが混在していた（例: 遊戯王「カテゴリ」40 枚で HERO / 閃刀姫 / 古代の機械 / 神 / カオス がバラバラに並ぶ）。

### 修正

`assignGroupToLayouts` から内部 sort を削除し、**並び順は呼び出し側の責任**とした：

- **isolate / merge**: 価格降順でソートして渡す（単一タグなので従来と同じ）
- **group**: `sortedRules` の順に rule ごとの該当カードを集め、各 rule 内で価格降順にしてから連結
- **メインタグ独立割付**: 価格降順でソートして渡す

これで group ページは「rule 定義順にタグごとまとまる → 各タグ内は価格降順」の並びになる。

既存の generated_page は sync/regenerate 経由でしか再計算されないため、セッション中に該当ページ（YU-GI-OH!: カテゴリ×3 / エクストラ、Pokemon: 25th_XY_BWR / メガシンカex_プロモ_マスボ / SAR_AR×3、ONE PIECE: 5 ページ）の `card_ids` を手動で並び替え → regen して反映した。

---

## 3. ONE PIECE BOX を box_8x5 テンプレで生成

### 問題

ONE PIECE の BOX タグ（4 枚）が `rule` 未設定のため、`page-planner.ts` の BOX 判定（`tag_pattern='BOX' && match_type='exact' && behavior='isolate'`）を通らず、通常 DP 割付で `grid_2x2` が選ばれていた。

### 対応

`rule` テーブルに以下を直接 INSERT：

```sql
franchise='ONE PIECE', tag_pattern='BOX', match_type='exact',
behavior='isolate', priority=90
```

既存 `generated_page` の該当ページは `layout_template_id` を `box_8x5` のレコードに差し替えて regenerate。次回以降の sync では自動で box_8x5 が選ばれる。

---

## 4. タグ書き戻しの OAuth 設定漏れ

### 問題

タグ管理 UI でカードにタグを設定すると `appendTagToHarakaDB` が Haraka DB スプレッドシートの「DB」タブに行を追加するはずだが、Cloud Run 上の `haraka-api` サービスには `GOOGLE_REFRESH_TOKEN` / `CLIENT_ID` / `CLIENT_SECRET` の env var が注入されていなかった。結果、**書き戻しが全件サイレント失敗**（`.catch()` でログだけ吐いて握りつぶす実装）し、今日だけで 116 件のタグが Haraka DB シートに反映されていない状態になっていた。

### 対応

1. **即時対応**: `gcloud run services update haraka-api --update-secrets=GOOGLE_REFRESH_TOKEN=haraka-oauth-refresh-token:latest,GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...` で Secret Manager の値を注入。新リビジョン `haraka-api-00037-gjf`。
2. **再発防止**: `packages/api/src/lib/haraka-db-sheet.ts` の `getAccessToken()` を job 側と同じく Secret Manager フォールバックに変更。env 未設定なら自動で Secret Manager から取得。
3. **穴埋め**: Haraka DB シートを読み込み、最新 run の tag 付き `prepared_card` との差分を取り、未反映の **116 件を一括 append**（`DB!A1438:H1553`、928 セル更新）。

---

## 5. ギャラリー UI: 詳細ボタンが縦書きに潰れる

### 問題

ページ名（例「虹ヒロインタロットパラレル」）が長いと、カードフッター flex レイアウトで「詳細」ボタンが圧縮され、縦書きに崩れていた。

### 修正

`packages/web/src/app/gallery/[date]/page.tsx`：
- 左タイトル: `flex-1 min-w-0` で truncate 有効化（長いラベルは「…」省略）
- 詳細ボタン: `flex-shrink-0 whitespace-nowrap` で圧縮・改行禁止
- `title` 属性に page_label 全文を入れてマウスオーバーで全表示

---

## 6. カード追加/削除時にテンプレを自動切替

### 問題

`POST /api/gallery/pages/:pageId/cards` と `DELETE /.../cards/:cardId` が `card_ids` のみ更新し `layout_template_id` は変えなかった。4 枠ページに 2 枚追加して 6 枚にしても `grid_2x2` のままで、regenerate すると 4 枚しか描画されず 2 枚が消える挙動だった。

### 修正

`packages/api/src/routes/gallery.ts` に以下を追加して、カード操作 API の末尾で呼ぶ：

```ts
async function pickLayoutForCardCount(supabase, franchise, cardCount) {
  // is_active な layout_template のうち box_8x5 以外を小さい順に並べ、
  // total_slots >= cardCount を満たす最小枠を返す（全て小さければ最大枠）
}

async function syncLayoutToCardCount(supabase, pageId, cardCount) {
  // BOX ページ (slug='box_8x5') は固定、それ以外は適合枠に更新
}
```

これで 4 枚→6 枚で `grid_3x2`、6 枚→2 枚で `grid_2x1`、のように枚数追従。BOX は固定。

---

## 7. Cloud Scheduler 再開

全 4 ジョブが PAUSED 状態で放置されていた。使用中の 2 つだけ再開：

- `haraka-morning-sync` (毎日 JST 09:00) → ENABLED
- `haraka-watchdog` (毎日 JST 09:10) → ENABLED
- `haraka-daily-sync` / `spectre-price-daily-0900` は PAUSED のまま

---

## 8. DB 修復作業（副次）

- **Pokemon 8 ページ**: `status='generated'` だが Storage に実体 404。`regenerate-page` で修復。根本原因は DB↔Storage 不整合（恒久対策は `PLAN.layout-variants.md` 末尾の TODO 参照）。
- **62 + 34 + 14 ページ**: レイアウト調整のたびにバッチ 3 並列で regenerate。62 件を一気に fork 投入すると Cloud Run メモリ不足で pending 詰まりするため、**バッチサイズ 2〜3 を推奨**。

---

## デプロイ手順の学び

- **Cloud Run (API/Job)**: `gcloud builds submit --config=cloudbuild.yaml --project=spectre-tomstocks-20260227` が必要。git push では反映されない。1 回あたり 約 8 分。
- **Web (Next.js)**: Vercel（ルート `vercel.json` で設定）。master への push で auto deploy（GitHub 連携前提）。
- **Cloud Scheduler**: `gcloud scheduler jobs resume/pause <id>`。
- **Cloud Run サービスへの Secret 注入**: `gcloud run services update <svc> --update-secrets=VAR=secret-name:latest`。

---

## 既存 TODO（`PLAN.layout-variants.md` 参照）

- DB↔Storage 不整合の堅牢化（upload→update 順序、失敗時 status、watchdog による 404 検知）
- PNG マジックバイト検証（`89 50 4E 47 0D 0A 1A 0A`）をアップロード系に仕込む
- `prepared_card` に `updated_at` カラムが無いため、タグ編集の時刻ベース追跡ができない（次回スキーマ改修で検討）
- `generate.ts` の BOX 判定が rule ベースなので、`YU-GI-OH!` の BOX タグが発生したら `franchise=YU-GI-OH!, tag_pattern=BOX` の isolate rule を追加する必要がある

---

## テスト環境メモ

`packages/job/src/__tests__/page-planner.test.ts` は `describe / it / expect` を import せず globals 前提で書かれているが、`vitest.config.ts` / `jest.config.*` が root/workspace に無いため、そのままでは実行できない。今回はビルド型チェック（`tsc --noEmit`）と本番データでの手動検証でカバーした。将来の改修時にテスト環境整備（vitest globals: true or import 追加）が必要。
