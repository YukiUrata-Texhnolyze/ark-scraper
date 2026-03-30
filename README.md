# ark-scraper

Power Automate Desktop で運用していた ark 用スクレイパーを Playwright / TypeScript へ移植したリポジトリです。

対象

- 楽天 `tek`
- 楽天 `pside`
- Amazon
- Western Digital

出力形式

- `.xlsx` ではなく `.csv`
- 既定の出力先は `./output`
- 一部ターゲットは途中保存に対応
- ファイル名は実行時刻ベースで共通化される

例

- `ama_2026-03-25_21-01-49.csv`
- `tek_2026-03-25_21-01-49.csv`
- `pside_2026-03-25_21-01-49.csv`
- `WD_2026-03-25_21-01-49.csv`

## 実行方法

全体実行

```bash
npx ts-node src/main.ts
```

個別実行

```bash
npx ts-node src/main.ts tek
npx ts-node src/main.ts pside
npx ts-node src/main.ts amazon
npx ts-node src/main.ts wd
```

## Amazon 運用メモ

この環境では Amazon が素直に開かず、以下の出し分けが発生します。

1. 最初に `ショッピングを続ける` 中間画面へ入ることがある
2. 中間画面通過後のお届け先が海外になっていることがある
3. お届け先が海外のままだと `merchant-items` の件数が減ることがある

実測では、お届け先が `シンガポール` のときは 28 件、`272-0031` に更新すると 62 件で完走しました。

### 推奨実行方法

```bash
AMAZON_DELIVERY_POSTAL_CODE=2720031 npx ts-node src/main.ts amazon
```

スクレイパーは以下を自動で試します。

1. Amazon トップを開く
2. `ショッピングを続ける` 中間画面を検知したら突破する
3. `AMAZON_DELIVERY_POSTAL_CODE` があれば配送先ポップオーバーへ郵便番号を入力する
4. `merchant-items` をページ単位 retry 付きで巡回する
5. 各ページごとに CSV を保存する

### Amazon persistent profile

通常ブラウザに近い状態を維持したい場合は persistent profile も使えます。

プロファイル作成

```bash
AMAZON_PERSISTENT_USER_DATA_DIR=./.playwright/amazon-profile HEADLESS=false npm run amazon:profile
```

同じプロファイルで実行

```bash
AMAZON_PERSISTENT_USER_DATA_DIR=./.playwright/amazon-profile AMAZON_DELIVERY_POSTAL_CODE=2720031 npx ts-node src/main.ts amazon
```

### Amazon 補助環境変数

- `AMAZON_PROFILE_TARGET_URL`: セットアップ時に最初に開く URL を上書き
- `AMAZON_DELIVERY_POSTAL_CODE`: 未ログインでもお届け先郵便番号を設定してから Amazon 一覧に入る
- `AMAZON_SETUP_AUTO_CLOSE_MS`: `amazon:profile` を自動で閉じる
- `AMAZON_PERSISTENT_USER_DATA_DIR`: Amazon のみ永続プロファイルを使う
- `AMAZON_MAX_PAGE_OPEN_ATTEMPTS`: Amazon 各ページの最大再試行回数
- `AMAZON_RETRY_DELAY_BASE_MS`: 再試行待機の基準ミリ秒
- `AMAZON_RETRY_DELAY_JITTER_MS`: 再試行待機の揺らぎミリ秒

## SharePoint アップロード

可能です。実装も入れてあります。

スクレイパー実行後、SharePoint 用の設定が揃っていれば成果物 CSV を Microsoft Graph 経由で指定フォルダへアップロードします。

### 必要な設定

`.env` に以下を設定します。

```env
SHAREPOINT_TENANT_ID=your-tenant-id
SHAREPOINT_CLIENT_ID=your-client-id
SHAREPOINT_CLIENT_SECRET=your-client-secret
SHAREPOINT_SITE_URL=https://texhnolyzebiz.sharepoint.com/sites/texhnolyze.biz
SHAREPOINT_FOLDER_PATH=/Shared Documents/General/本間様用
```

### 必要な権限

Azure AD / Entra ID のアプリ登録で、少なくとも Microsoft Graph の以下に相当する権限が必要です。

- `Files.ReadWrite.All`
- `Sites.ReadWrite.All`

管理者同意が必要な構成です。

### アップロード対象

実行したターゲットに対応する CSV をアップロードします。

例

- `tek_2026-03-25_21-01-49.csv`
- `pside_2026-03-25_21-01-49.csv`
- `ama_2026-03-25_21-01-49.csv`
- `WD_2026-03-25_21-01-49.csv`

### 動作タイミング

各スクレイパーの処理が終わった後、`main.ts` の最後で既存ファイルをまとめてアップロードします。

設定が足りない場合はアップロードをスキップします。

アップロード成功後は、出力ディレクトリの内容を空にします。

アップロード前に、指定 SharePoint フォルダ直下にあるファイルのうち、最終更新日が 1 か月より前のものを削除します。

## 備考

- Amazon は環境差分が強いため、README に書いた配送先条件を優先してください
- WD は途中保存と再開を入れているため、長時間実行でも途中結果が残ります
- エラー時は既存メール送信処理を使います