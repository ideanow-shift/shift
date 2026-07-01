# シフトアプリ HUB Context Contract

作成日: 2026-07-01
対象: NOV HUB -> シフト自動生成アプリ

## 目的

NOV HUBからシフト自動生成アプリを開くときに、ログイン中ユーザーと権限判定に必要な最小contextを渡す。
シフトアプリ側はこのcontextをBackend APIへ同梱し、Edge Function側で監査ログ・生成履歴・将来の権限判定に利用する。

## 渡し方

URL queryに `hub_context` を付ける。

```text
https://ideanow-shift.github.io/shift/shift_demo.html?hub_context=<base64url(JSON)>
```

互換用に `context` も読み取るが、正式名称は `hub_context` とする。

## エンコード

- JSONをUTF-8で文字列化
- Base64URLエンコード
- `+` は `-`、`/` は `_`、末尾の `=` は省略可

## 推奨JSON schema

```json
{
  "employeeId": "00000000-0000-4000-8000-000000000000",
  "employeeNo": "1234",
  "firebaseUid": "firebase-user-uid",
  "email": "user@example.com",
  "roles": ["store_manager"],
  "storeIds": ["00000000-0000-4000-8000-000000000001"],
  "primaryStoreId": "00000000-0000-4000-8000-000000000001",
  "source": "nov_hub",
  "issuedAt": "2026-07-01T00:00:00.000Z"
}
```

## 必須フィールド

短期では必須は `employeeId` のみ。

- `employeeId`
  - `public.employees.id`
  - UUID
  - 監査ログの `actor_employee_id` と生成履歴の `executed_by` に使う

## 推奨フィールド

- `firebaseUid`
  - 将来Backend側でFirebase ID token検証をするための補助情報
- `roles`
  - `store_manager` / `area_manager` / `backoffice` / `super_admin` など
  - 最終的にはBackend側で `employee_roles` / `roles` を再照会して確定する
- `storeIds`
  - 操作可能店舗の候補
  - 最終的にはBackend側で再検証する
- `primaryStoreId`
  - HUBから開いた時の初期表示店舗候補
- `issuedAt`
  - context発行時刻
  - 将来、有効期限チェックに使う

## シフトアプリ側の現在の実装

`shift_demo.html` は以下を行う。

- `hub_context` または `context` を読み取る
- Base64URLとしてdecodeする
- JSON parseに失敗した場合は空contextとして扱う
- `saveShift` / `saveSettings` / `aiAdjust` のpayloadへ `hubContext` を同梱する

## Edge Function側の現在の実装

`shift-api` は以下をactor候補として扱う。

- `request.actorEmployeeId`
- `request.employeeId`
- `hubContext.employeeId`
- `hubContext.employee_id`
- `hubContext.coreEmployeeId`
- `hubContext.core_employee_id`

UUID形式の場合のみ採用する。

保存先:

- `shift_audit_logs.actor_employee_id`
- `shift_generation_runs.executed_by`

metadata:

- `hub_context_present: true/false`

## セキュリティ方針

`hub_context` はフロントURLに載るため、信頼済み情報として扱わない。
短期では監査ログ補助として使う。
中期以降はBackend側でFirebase ID token / employee id / rolesを再検証し、contextは入力ヒントとしてのみ扱う。

## 次に実装すること

1. HUB側で上記schemaの `hub_context` を生成する。
2. シフトアプリ側で `primaryStoreId` があれば初期店舗選択に使う。
3. Edge Function側で `employee_roles` / `roles` を照会し、操作権限を判定する。
4. Firebase ID token検証方式を決める。
