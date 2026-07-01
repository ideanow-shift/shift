# シフトアプリ HUB Context Contract

更新日: 2026-07-02
対象: NOV HUB -> シフト自動生成アプリ

## OS回答反映済み方針

- シフト側の正本社員IDは `employees.id`。
- シフト側の正本店舗IDは `stores.id`。
- `core_employee_id` は `employees.id` の実体として扱う。
- `core_store_id` は `stores.id` の実体として扱う。
- `current_store_id` はHUBから固定で渡す値ではなく、シフトアプリ内の現在選択店舗として扱う。
- 初期店舗は `primaryStoreId` を優先する。

## 渡し方

URL queryに `hub_context` を付ける。

```text
https://ideanow-shift.github.io/shift/shift_demo.html?hub_context=<base64url(JSON)>
```

互換用に `context` も読み取るが、正式名称は `hub_context` とする。

## 推奨JSON schema

```json
{
  "employeeId": "00000000-0000-4000-8000-000000000000",
  "supabaseEmployeeId": "00000000-0000-4000-8000-000000000000",
  "firebaseUid": "firebase-user-uid",
  "email": "user@example.com",
  "fullName": "山田 太郎",
  "roleKeys": ["store_manager"],
  "roles": ["store_manager"],
  "primaryStoreId": "00000000-0000-4000-8000-000000000001",
  "storeAssignments": [
    {
      "storeId": "00000000-0000-4000-8000-000000000001",
      "roleKeys": ["store_manager"]
    }
  ],
  "source": "nov_hub",
  "issuedAt": "2026-07-02T00:00:00.000Z"
}
```

## シフト側で吸収する互換キー

社員ID:

- `employeeId`
- `supabaseEmployeeId`
- `employee_id`
- `supabase_employee_id`
- `coreEmployeeId`
- `core_employee_id`

Firebase UID:

- `firebaseUid`
- `firebase_uid`

権限:

- `roleKeys`
- `role_keys`
- `roles`

店舗:

- `primaryStoreId`
- `primary_store_id`
- `storeIds`
- `store_ids`
- `storeAssignments`
- `store_assignments`

## 権限方針

短期はEdge Function + service_role経由で保存する。フロントへservice_roleは出さない。
中長期はHUB認証、Edge Function、RLS/再検証へ寄せる。

推奨ロール:

- `staff`: 自分のシフト閲覧、希望提出
- `store_manager`: 自店舗の作成・編集・保存・確定
- `area_manager`: 担当店舗範囲の閲覧・編集
- `fc_owner`: 自法人・自店舗範囲の閲覧、必要に応じて編集
- `backoffice`: 全店舗管理
- `super_admin`: 全店舗管理
- `executive`: 原則閲覧中心

## Edge Functionでの利用

現時点では `hubContext` を保存・設定・AI調整payloadへ同梱し、以下に利用する。

- `shift_audit_logs.actor_employee_id`
- `shift_generation_runs.executed_by`
- metadataの `hub_context_present`

権限判定は次段階で `employee_roles.scope_type = store` / `scope_id = stores.id` を照会して実装する。
