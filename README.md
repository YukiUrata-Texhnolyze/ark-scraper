# ark-scraper

Power Automate Desktop で運用していた ark 用スクレイパーを Playwright / TypeScript へ移植したリポジトリです。

対象

- 楽天 `tek`
- 楽天 `pside`
- Amazon
- Western Digital
- Ark メモリ `ark-memory`
- Ark SSD `ark-ssd`

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

補足

- 引数なし実行は既存の `tek / pside / amazon / wd` のみです
- `ark-memory` / `ark-ssd` は既存 cron へ影響を出さないよう、明示ターゲットでのみ実行します

個別実行

```bash
npx ts-node src/main.ts tek
npx ts-node src/main.ts pside
npx ts-node src/main.ts amazon
npx ts-node src/main.ts wd
npx ts-node src/main.ts ark-memory
npx ts-node src/main.ts ark-ssd
```

npm scripts

```bash
npm run ark:memory
npm run ark:ssd
npm run ark:all
```

## WSL 自動定期実行

この WSL では `cron` が有効なので、`@reboot` で WSL 起動時に自動実行し、さらに固定スケジュールでも再実行する構成にできます。

既定値

- WSL 起動時に 1 回実行
- 毎日 `05:00` に再実行 (`0 5 * * *`)

インストール

```bash
cd /home/urata/ark-scraper
chmod +x scripts/run-scheduled-scrape.sh scripts/install-wsl-cron-scheduler.sh
./scripts/install-wsl-cron-scheduler.sh --name standard
```

スケジュールを変更したい場合

```bash
cd /home/urata/ark-scraper
./scripts/install-wsl-cron-scheduler.sh --name standard --cron '0 * * * *'
./scripts/install-wsl-cron-scheduler.sh --name standard --cron '30 9,15,21 * * *' --boot @reboot
./scripts/install-wsl-cron-scheduler.sh --name ark --cron '15 6,12,18 * * *' --no-boot --target ark-memory --target ark-ssd
```

状態確認

```bash
crontab -l
systemctl status cron --no-pager
tail -n 200 ~/.local/state/ark-scraper/scheduler.log
tail -n 200 ~/.local/state/ark-scraper/scheduler-ark.log
```

停止

```bash
crontab -l | sed '/# BEGIN ark-scraper-scheduler/,/# END ark-scraper-scheduler/d' | crontab -
```

補足

- 実行時に前回ジョブがまだ動いていれば、その周期は自動で skip します
- `src/` や `package.json` に変更があれば、実行前に自動で `npm run build` します
- `scripts/run-scheduled-scrape.sh` は target 引数をそのまま `dist/main.js` へ渡します
- lock file は target ごとに分かれるので、`standard` と `ark` を別 cron にしても相互に skip しません
- 通常ジョブは `tek / pside / amazon / wd` のみを回し、Ark は別ジョブに分ける運用を想定しています
- `cron` は固定時刻ベースです。前回完了からの相対間隔で回したい場合は `systemd timer` のほうが向いています

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

## Ark 運用メモ

Ark メモリ / SSD はこの repo に統合しましたが、既存 SharePoint フローとは分離しています。

- `ark-memory` / `ark-ssd` は SharePoint へ送らず、R2 設定があれば CSV を R2 へアップロードします
- ローカル CSV は `./output`、証跡 JSON / HTML / PNG は `./playwright-artifacts` 配下へ保存します
- Ark-only 実行では、R2 アップロード成功後に `./output` の中身を掃除します
- 初回は Cloudflare 確認のため `HEADLESS=false` 実行が必要なことがあります
- storage state は既定で `./playwright-artifacts/ark-storage.json` に保存 / 再利用します

### 必須設定

Ark は URL を明示設定してください。

```env
ARK_MEMORY_URLS=https://www.ark-pc.co.jp/search/?category=c21&col=5&limit=50&order=1&p1=b21020&p3=h21830%3Ah21571&p5=s21010&p6=w11728%3Aw11729%3Aw11730%3Aw11731%3Aw11732,https://www.ark-pc.co.jp/search/?category=c21&col=3&key=288pin%20DDR5-&limit=50&p1=b21010&p2=c21060&p3=h21830%3Ah21850&p4=p21098%3Ap21205%3Ap21099%3Ap21097%3Ap21096&p5=s21010
ARK_SSD_URLS=https://www.ark-pc.co.jp/search/?col=3&label_code=KIOXIA&limit=50&p1=b32020&p3=h32032&p4=p32030%3Ap32040,https://www.ark-pc.co.jp/search/?col=3&label_code=Princeton&limit=50&p1=b32020&p3=h32032&p4=p32030%3Ap32040,https://www.ark-pc.co.jp/search/?col=3&label_code=SAMSUNG&limit=50&p1=b32020&p3=h32032&p4=p32030%3Ap32040,https://www.ark-pc.co.jp/search/?col=3&label_code=Western%20Digital&limit=50&p1=b32020&p3=h32032&p4=p32030%3Ap32040,https://www.ark-pc.co.jp/search/?col=3&key=SNV&label_code=Kingston&limit=50&p1=b32020&p3=h32032&p4=p32030%3Ap32040&search_target=on
```

任意設定

- `ARK_ARTIFACT_DIR`: Ark の証跡保存先
- `ARK_STORAGE_STATE_PATH`: Cloudflare 通過後の storage state 保存先
- `ARK_TIMEOUT_MS`: 1 ページの待機タイムアウト
- `ARK_MEMORY_MAX_PAGES`: メモリ一覧のページ上限 (`0` で自動)
- `ARK_DEBUG=true`: 先頭数件をコンソール出力

### 初回実行例

```bash
HEADLESS=false npx ts-node src/main.ts ark-memory
HEADLESS=false npx ts-node src/main.ts ark-ssd
```

Cloudflare の確認をブラウザ上で完了すると、次回以降は保存済み storage state を再利用できます。

### R2 アップロード

R2 設定が揃っていれば、Ark の CSV を以下のキーへアップロードします。

- `ark_csv/ark-memory-latest.csv`
- `ark_csv/ark-ssd-latest.csv`

設定例

```env
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET=your-bucket-name
R2_REGION=auto
```

## SharePoint アップロード

可能です。実装も入れてあります。

スクレイパー実行後、SharePoint 用の設定が揃っていれば成果物 CSV を Microsoft Graph 経由で指定フォルダへアップロードします。

Ark の `ark-memory` / `ark-ssd` は SharePoint へは送られません。

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