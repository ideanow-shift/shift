# シフト自動生成システム Supabase移行計画

作成日: 2026-06-28
対象: シフト自動生成アプリ / NOV HUB / idea-nov-core

## 結論

現行のシフト自動生成システムは止めずに運用しながら、裏側を段階的にSupabaseへ差し替える。

いきなりHUB内アプリへ作り直すより、まずは次の順で進める。

1. Core DB参照化
2. 設定保存のSupabase化
3. シフト保存のSupabase化
4. 生成履歴と監査ログ追加
5. GASからSupabase Edge Functionsへ移行
6. NOV HUB統合

## 現状

- フロントエンド: GitHub Pages `shift_demo.html`
- Backend API: GAS Webアプリ `gas_api.js`
- 店舗マスタ / 社員マスタ: 現状はスプレッドシート読み取り
- シフト保存: GAS経由でスプレッドシート `ShiftData`
- 設定保存: GAS経由でスプレッドシート `ShiftSettings`
- NOV HUB連携: ポータルから公開URLへ遷移

現場運用が始まっているため、短期ではGitHub Pages + GASを維持する。

## 目標アーキテクチャ

```text
NOV HUB
  ↓
シフト作成アプリ
  - 短期: GitHub Pages
  - 長期: NOV HUB配下アプリ
  ↓
Backend API
  - Phase 1: GAS + Supabase service_role
  - Phase 2: Supabase Edge Functions
  ↓
idea-nov-core
  - employees
  - stores
  - roles
  - employee_roles
  - shift_* tables
```

## ID方針

NOV HUBの既存方針に合わせる。

- 社員ID: `public.employees.id`
- 店舗ID: `public.stores.id`
- 社員番号: `public.employees.employee_id`
- 店舗コード: `public.stores.store_id`

シフトDBでは社員名・店舗名を正本として保存しない。表示用キャッシュや監査ログの補助情報を除き、基本は `employee_id` / `store_id` の外部キーで参照する。

## prefix方針

- シフト予定、自動生成、希望休、店舗別設定: `shift_`
- 将来の打刻・勤怠実績: `attendance_`

シフトは勤務予定であり勤怠実績ではないため、`attendance_` には混ぜない。

## 移行フェーズ

### Phase 1: Core DB読み取り化

目的: 社員・店舗マスタの正本をSupabaseへ移す。

- GASから `employees` / `stores` を読む
- 既存HTMLの店舗一覧・社員一覧の形へ変換して返す
- スプレッドシートの名簿・店舗表はバックアップ扱いへ落とす
- 書き込み処理はまだ既存Sheetsへ残す

この段階では、現場画面の操作感は変えない。

### Phase 2: 設定保存のSupabase化

目的: 店舗設定・スタッフ別ルールをDBで構造化する。

- `shift_store_settings`
- `shift_staff_rules`

対象データ:

- 店舗別の最低人数
- 土日祝公休制限
- 希望休上限
- 特記事項
- 固定休曜日
- 隔週休などのスタッフ別ルール

GASはしばらく中継役として残す。

### Phase 3: シフト保存のSupabase化

目的: シフト表本体をSupabaseへ保存する。

- `shift_schedules`
- `shift_schedule_cells`

`shift_schedules` は店舗・年月・状態単位のヘッダ、`shift_schedule_cells` は社員x日付のセルとして保存する。

スプレッドシート `ShiftData` は移行バックアップ、または一時的なエクスポート先にする。

### Phase 4: 生成履歴・監査ログ

目的: 自動生成とAI調整の説明責任を残す。

- `shift_generation_runs`
- `shift_audit_logs`

記録する内容:

- 実行者
- 店舗
- 年月
- 自動生成条件
- AI調整プロンプト
- 適用結果
- 手修正の差分

### Phase 5: Edge Functions化

目的: GAS依存を下げる。

- 保存API
- 読み込みAPI
- AI調整API
- 権限判定

これらをSupabase Edge Functionsへ移す。

Phase 5完了後、GASは旧バージョン互換または緊急退避用に降格する。

### Phase 6: NOV HUB統合

目的: NOV HUBログインと権限を使った正式アプリにする。

- HUB contextからログイン中の `employees.id` を受ける
- Backend側でFirebase UID / employee idを再検証する
- `employee_roles` / `roles` で権限判定する
- 店長、本部、スタッフの画面と操作権限を分ける

## 権限方針

短期:

- GASまたはEdge Functionが `service_role` でSupabaseへアクセス
- フロントエンドに `service_role` は置かない
- anonキーからの直接書き込みは禁止
- RLSは有効化するが、Phase 1では許可ポリシーを最小限にする

長期:

- NOV HUBログインを前提にする
- Backend側でactorを再検証する
- role keyで操作範囲を制御する

想定ロール:

- `super_admin` / `backoffice`: 全店舗管理
- `executive`: 全店舗閲覧
- `area_manager`: 担当店舗閲覧・編集
- `store_manager`: 自店舗の作成・編集・確定
- `staff`: 自分または所属店舗の閲覧、希望休申請
- `fc_owner`: 自法人・自店舗範囲

## テーブル責務

| table | 役割 |
| --- | --- |
| `shift_store_settings` | 店舗別のシフト作成設定 |
| `shift_staff_rules` | 社員別の固定休・勤務タイプ・特記事項ルール |
| `shift_schedules` | 店舗・年月ごとのシフト表ヘッダ |
| `shift_schedule_cells` | 社員x日付のシフトセル |
| `shift_generation_runs` | 自動生成・AI調整の実行履歴 |
| `shift_requests` | 希望休・有休・出勤希望 |
| `shift_audit_logs` | 保存・確定・公開・手修正の監査ログ |

## 現行データとの対応

| 現行 | 移行先 |
| --- | --- |
| 店舗一覧スプレッドシート | `stores` |
| 社員名簿スプレッドシート | `employees` |
| 店舗別設定 | `shift_store_settings` |
| スタッフ別設定 | `shift_staff_rules` |
| `ShiftData` | `shift_schedules` + `shift_schedule_cells` |
| `ShiftSettings` | `shift_store_settings` + `shift_staff_rules` |
| AI調整結果 | `shift_generation_runs` + `shift_schedule_cells` |

## ロールアウト順

1. SQLドラフトをSupabase検証環境で実行
2. GASにSupabase接続設定を追加
3. `loadShift` の店舗・社員取得だけSupabase参照へ切り替え
4. 店舗単位で表示確認
5. 設定保存をSupabaseへ切り替え
6. シフト保存をSupabaseへ切り替え
7. GitHub Pages版で安定運用
8. HUB配下アプリ化

## ロールバック

- Phase 1ではSheets保存を残すため、Core DB参照に問題が出たらマスタ読み取りだけSheetsへ戻せる。
- Phase 2では設定保存先をSheets/Supabaseで切り替えられるフラグを用意する。
- Phase 3では保存時に一定期間Sheetsへもミラーしておく。

## 直近の優先順位

1. 店長フィードバック対応を継続する
2. 自動生成ロジックをHTMLから分離しやすくする
3. `employees` / `stores` 読み取りをSupabase化する
4. `shift_store_settings` / `shift_staff_rules` を導入する
5. `shift_schedules` / `shift_schedule_cells` に保存する

## 未決事項

- 店舗ごとの公開フローを `draft / confirmed / published` のどこまで使うか
- スタッフ自身の希望休入力をいつ開放するか
- AI調整プロンプトと結果をどこまで監査ログに保存するか
- Edge Functions移行時のFirebase ID token検証方式
- 既存スプレッドシートからの初回移行バッチの実装方法
