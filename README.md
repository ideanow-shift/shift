# IDEA NOV シフト管理システム

美容室グループ「IDEA NOV」（BASSA・KYARA HALF）向けの
シフト自動生成・管理ダッシュボードです。

## 🌐 アクセスURL
https://ideanow-shift.github.io/shift/shift_demo.html

## ✅ 実装済み機能

### データ連携
- Supabase Edge Function経由でCore DBの店舗・社員・職種情報を自動取得
- Googleスプレッドシート/GAS連携は旧バックアップ経路として保持
- 退職者・産休育休スタッフの自動除外

### シフト自動生成
- 完全週休2日（日曜起算・月をまたいでも週ルール優先）
- 火曜定休店の定休日を休み合計にカウント
- 6連勤以上禁止チェック
- 最低出勤人数を考慮した公休配置
- 年月切り替え対応（月をまたいでデータ保持）
- 2026〜2027年の祝日対応

### 店舗・スタッフ管理
- 店舗ごとの最低出勤人数設定（平日・土日別）
- スタッフ個別ルール設定（休日タイプ・勤務タイプ・希望休上限・特記事項）
- 時短スタッフの勤務時間個別設定
- イレギュラー設定（本人希望による週休日数・連勤上限・最低出勤人数制約の特例運用）

### AIシフト調整
- Supabase Edge Function経由でAnthropic Claude / Geminiと連携
- 「村山さん12日希望休、19日コンテストで田中・佐藤中抜け」などの自然言語要望を解釈
- 禁止事項（6連勤・最低人数・希望休上限・公平性）をシステムプロンプトで遵守
- スタッフ個別ルール・時短勤務時間・イレギュラー特例も自動でプロンプトに反映
- 適用された変更内容と却下理由を画面下に表示

### カレンダーUI
- 30日／31日／うるう年すべて動的描画
- 日付ヘッダー下に「出勤人数」をリアルタイム表示
  - 最低人数以上は緑、未満は赤背景でハイライト
- セルクリックで「出／公／希／時／会／研」スタンプを切替
- 時短スタッフは勤務時間を氏名下に小さく表示
- イレギュラー設定中のスタッフは⚠️マークで一目で識別

### 出力・エクスポート
- 確定シフトをCSVで書き出し
- 時短スタッフの出勤日は「時(8:40-15:00)」形式で勤務時間を付記
- 火曜定休店の火曜は「定休」として出力

## 🛠️ 技術スタック

- フロントエンド: 単一HTMLファイル（Vanilla JS / CSS）
- バックエンド: Supabase Edge Function（`supabase/functions/shift-api/index.ts`）
- データソース: Supabase / Core DB
  - 店舗: `public.stores`
  - 社員: `public.employees`
  - 職種: `public.job_types`
  - シフト保存: `shift_schedules` / `shift_schedule_cells`
  - 店舗設定: `shift_store_settings` / `shift_staff_rules`
- AI連携: Supabase Edge Function経由でAnthropic / Gemini APIを利用
- 退避経路: `gas_api.js` とGoogleスプレッドシート連携を旧バックアップとして保持

## 🔧 セットアップ

1. `shift_demo.html` の `SHIFT_API_URL` にSupabase Edge Function URLを設定
2. Supabase Edge Function `shift-api` をデプロイ済みであることを確認
3. ブラウザで `shift_demo.html` またはGitHub Pages URLを開く
4. 保存・読込ステータスが `Supabase` になることを確認
5. AI調整を使う場合はBackend側AIキー、または画面入力キーを利用する

旧GAS URLは `BACKUP_API_URL` として緊急退避用にのみ扱います。

## 📁 ファイル構成

```
idea-nov-system/
├── shift_demo.html   # メインダッシュボード（UI + ロジック）
├── supabase/functions/shift-api/index.ts  # Supabase Edge Function
├── gas_api.js        # 旧バックアップ用GAS Web API
└── README.md         # 本書
```
