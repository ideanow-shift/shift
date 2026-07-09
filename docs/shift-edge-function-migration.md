# シフト管理 Edge Function移行メモ

作成日: 2026-06-30
対象: `shift_demo.html` / Supabase Edge Functions

2026-07-07時点では、通常運用はSupabase Edge Function経由です。GASは緊急退避用として残しています。

## 目的

GAS Web APIを緊急退避用に残しながら、通常運用のバックエンドをSupabase Edge Functionへ移す。

現在は `shift_demo.html` の `SHIFT_API_URL` にEdge Function URLを設定して運用する。既存GASは緊急退避用の `BACKUP_API_URL` としてのみ扱う。

## Edge Function

追加ファイル:

- `supabase/functions/shift-api/index.ts`

API契約は既存GASと合わせる。

- `GET /functions/v1/shift-api`
  - 店舗マスタ、社員マスタをSupabase Core DBから返す
- `GET /functions/v1/shift-api?action=loadSettings&storeId=...`
  - 店舗設定、スタッフ別ルールを返す
- `GET /functions/v1/shift-api?action=loadShift&storeId=...&year=2026&month=6`
  - シフトセルを返す
- `POST /functions/v1/shift-api` + `{ action: "saveSettings", ... }`
  - 店舗設定、スタッフ別ルールを保存する
- `POST /functions/v1/shift-api` + `{ action: "saveShift", ... }`
  - `shift_schedules` / `shift_schedule_cells` に保存する
- `POST /functions/v1/shift-api` + `{ action: "aiAdjust", ... }`
  - AI調整を実行する

## 必要なSecrets

`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` はSupabase Edge Functions側で予約済みの標準環境変数として提供されるため、`supabase secrets set` では登録しない。

AI調整をサーバー側キーで使う場合のみ追加する。

```powershell
supabase secrets set ANTHROPIC_API_KEY=<key> --project-ref nkmxevmioczcmnldreyo
# または
supabase secrets set GEMINI_API_KEY=<key> --project-ref nkmxevmioczcmnldreyo
```

## デプロイ

```powershell
supabase functions deploy shift-api --project-ref nkmxevmioczcmnldreyo --no-verify-jwt
```

デプロイ後のURL:

`	ext
https://nkmxevmioczcmnldreyo.supabase.co/functions/v1/shift-api
`$insert

## フロント切替

`shift_demo.html` の `SHIFT_API_URL` にEdge Function URLを入れる。

```js
const SHIFT_API_URL = "https://nkmxevmioczcmnldreyo.supabase.co/functions/v1/shift-api";
```

通常運用では空欄にしない。GASへ戻す判断は緊急退避時のみ行う。

```js
const SHIFT_API_URL = "";
```

## ロールバック

Edge Function側で問題が出た場合は、Core DB番人/運用判断のうえで旧GAS退避経路へ戻す。通常運用で `SHIFT_API_URL` を空欄にしない。

## セキュリティメモ

- `SUPABASE_SERVICE_ROLE_KEY` はEdge Functionの保護された環境にのみ置く。GASは旧退避経路として扱う。
- `shift_demo.html`、GitHub Pages、ブラウザには置かない。
- 公開フロントからSupabaseへ直接service_roleでアクセスしない。
