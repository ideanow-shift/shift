# シフト自動生成システム 現状メモ

作成日: 2026-07-01
対象: `shift_demo.html` / Supabase Edge Function `shift-api`

## 現在の結論

シフト自動生成システムは、現場運用を止めずに Supabase 仕様へ段階移行中。
現在はフロントエンドを GitHub Pages に置き、主要 Backend API は Supabase Edge Function `shift-api` を使う構成になっている。

## 公開・配置

- フロント: `https://ideanow-shift.github.io/shift/shift_demo.html`
- ローカルHTML: `C:\Users\bassa\Desktop\idea-nov-system\shift_demo.html`
- Edge Function: `C:\Users\bassa\Desktop\idea-nov-system\supabase\functions\shift-api\index.ts`
- Supabase Function URL: `https://nkmxevmioczcmnldreyo.supabase.co/functions/v1/shift-api`
- GitHub remote: `https://github.com/ideanow-shift/shift.git`

## 実装済み

### フロント側

- `SHIFT_API_URL` は Supabase Edge Function を指している。
- `BACKUP_API_URL` は退避用Backendとして残している。
- 画面上の保存・読込表示は `Supabase` / `Backup API` / `Sheets` 表記へ整理済み。
- 旧GAS前提の内部関数名は `Backend` 表記へ整理済み。
- 店長向けUIはNOVA寄せで、絵文字感を減らし、操作導線を少し整理済み。
- 店長フィードバックの「1・3週目月曜公休、2・4週目月曜必ず出勤」系の特記事項解析を改善済み。
- URLの `hub_context` / `context` を読み取り、Backend payloadへ同梱する下準備を実装済み。

### Supabase / Edge Function側

- Core master読込:
  - `stores`
  - `employees`
  - `positions`
- 設定保存・読込:
  - `shift_store_settings`
  - `shift_staff_rules`
- シフト保存・読込:
  - `shift_schedules`
  - `shift_schedule_cells`
- AI調整:
  - `aiAdjust` action
  - Edge Function secrets または画面入力APIキーを利用
  - 実行履歴を `shift_generation_runs` へ `ai_adjust` として記録
  - レスポンスに `generationLogged: true/false` を返す
- HUB context / actor:
  - `hubContext.employeeId` / `employee_id` / `coreEmployeeId` / `core_employee_id` をactor候補として扱う
  - UUID形式の場合のみ `shift_audit_logs.actor_employee_id` / `shift_generation_runs.executed_by` に保存
  - context有無はmetadataへ `hub_context_present` として記録
- 監査ログ:
  - `saveShift` 成功時に `shift_audit_logs` へ `save_shift` を記録
  - `saveSettings` 成功時に `shift_audit_logs` へ `save_settings` を記録
  - レスポンスに `auditLogged: true/false` を返す
  - 監査ログ保存失敗時も本体保存は止めない

## 直近コミット

- `be6c02e` Pass HUB context to shift backend
- `bc41be3` Log AI shift adjustment runs
- `dc59af4` Document current shift Supabase migration status
- `76a8acf` Normalize shift backend source labels
- `e45621b` Return audit log status from shift API
- `b6b906d` Add shift audit logs in edge function
- `2ba188c` Clarify shift backup backend label
- `40c93b5` Rename shift backend helper functions

## 現在の注意点

- `BACKUP_API_URL` は残しているが、通常運用は Supabase Edge Function 優先。
- `deno check` は現在の端末PATH上で `deno` が見つからず未実行。
- Edge Functionのデプロイは `npx supabase functions deploy shift-api --project-ref nkmxevmioczcmnldreyo --no-verify-jwt` で成功済み。
- デプロイ時に Docker warning は出るが、Function deploy 自体は成功している。
- 未追跡ファイルとして `shift_demo_3-1.html`、`supabase/.temp/`、`保管.txt` がある。現時点では触っていない。

## 次の優先作業

1. 実画面でシフト保存・設定保存・AI調整を行い、`shift_audit_logs` / `shift_generation_runs` に記録されるか確認する。
2. HUBから渡すcontextの正式schemaを決める。
3. Backend側でactorの権限判定を追加する。
4. `BACKUP_API_URL` をいつ撤廃するか判断する。
5. HUB埋め込み時の見え方と権限導線を確認する。
