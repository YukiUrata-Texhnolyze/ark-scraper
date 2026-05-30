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

生成データの保持方針

- `output/` と `playwright-artifacts/` は git 管理外です
- timestamp 付き run はセグメントごとに直近 3 件だけ自動保持します
- 対象には通常 CSV、market 系 CSV / JSONL / 証跡、`ark-*` 証跡、`bic-home-probe`、SharePoint staging を含みます

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
npm run market:smoke
npm run market:official-site
npm run market:amazon-search
npm run market:bic-search-browsermcp
npm run market:bic-parse-html
npm run amazon:profile
npm run bic:profile
npm run bic:probe-home
```

## Market Research 基盤

市場調査向けの `market-*` ターゲット用に、config 読み込み、出力、証跡保存の共通基盤を追加しています。

補足

- 今回の実装は `market-smoke`、`market-official-site`、`market-amazon-search`、`market-bic-search-browsermcp` です
- `market-*` は疎通確認や後続実装向けの土台であり、引数なし実行には含めません
- 既存の `amazon` ターゲットは従来どおり特定マーチャント一覧取得用です

### market-smoke 実行方法

明示ターゲットでのみ実行します。

```bash
npx ts-node src/main.ts market-smoke --config configs/market/sample.json
```

または環境変数でも指定できます。

```bash
MARKET_RESEARCH_CONFIG_PATH=configs/market/sample.json npx ts-node src/main.ts market-smoke
```

サンプル npm script:

```bash
npm run market:smoke
```

### market-official-site 実行方法

`officialUrls` に並べた公式商品ページやブランドページを直接巡回します。

```bash
npx ts-node src/main.ts market-official-site --config configs/market/sample.json
```

```bash
MARKET_RESEARCH_CONFIG_PATH=configs/market/sample.json npx ts-node src/main.ts market-official-site
```

```bash
npm run market:official-site
```

### market-amazon-search 実行方法

`queries.amazon` に並べた検索クエリを Amazon Japan で巡回し、上位 20 件程度の競合商品を収集します。

```bash
npx ts-node src/main.ts market-amazon-search --config configs/market/sample.json
```

```bash
MARKET_RESEARCH_CONFIG_PATH=configs/market/sample.json npx ts-node src/main.ts market-amazon-search
```

```bash
npm run market:amazon-search
```

補足

- `queries.amazon` が空の場合は config エラーで停止します
- query ごとに HTML / PNG / metadata を保存します
- block / CAPTCHA / continue-shopping 中間画面でも証跡と record を残します
- CAPTCHA や bot 検知を強引に突破する実装は行いません
- 既存 `amazon` ターゲットの挙動は変更しません

Amazon の検索結果取得を安定させたい場合は、既存の永続プロファイル運用も使えます。

```bash
AMAZON_PERSISTENT_USER_DATA_DIR=.playwright/profiles/amazon-research HEADLESS=false npm run amazon:profile
AMAZON_PERSISTENT_USER_DATA_DIR=.playwright/profiles/amazon-research npm run market:amazon-search
```

人間が通常ブラウザに近い headful セッションでログイン状態や配送先、確認画面を整え、その profile を `market-amazon-search` で再利用する想定です。CAPTCHA / bot detection を自動突破する実装は行いません。

### BicCamera 方針

この repo では BicCamera を通常の Playwright スクレイピング target として扱いません。

- Linux / WSL 実行では `ERR_HTTP2_PROTOCOL_ERROR` や Akamai block が継続しているため、定常取得・blind retry・通常 probe を前提にしません
- Bic の実調査は BrowserMCP 接続済みブラウザタブを使う manual / operator-assisted 経路を正とします
- repo に残す Bic tooling は BrowserMCP 用 query plan、保存 HTML parse、headful 診断用 probe に限定します

運用方針と棚卸しは [BICCAMERA_POLICY.md](BICCAMERA_POLICY.md) にまとめています。

### market-bic-search-browsermcp 実行方法

```bash
npm run market:bic-search-browsermcp
```

`market-bic-search-browsermcp` は定期実行用スクレイパーではありません。通常の HTTP automation で安全に扱えない状況に限って、人の明示的な指示の下で BrowserMCP を使う manual / operator-assisted 経路として扱います。

補足

- 現状の `market-bic-search-browsermcp` は query plan の CSV / JSONL を出力する skeleton です
- 実際のブラウザ操作は AI agent が MCP 経由で BrowserMCP tool を使って進める前提です
- Akamai challenge や block を無人で突破する目的の定期実行には使いません

### Bic saved HTML parse

保存済みの Bic 検索 HTML を offline で parse したい場合だけ使います。

```bash
npm run market:bic-parse-html -- --input /path/to/bic-search.html --query "ポータブル エスプレッソマシン"
```

### Bic profile setup

ビックカメラ用に human-in-the-loop の headful troubleshooting script を追加しています。Cookie 同意、確認画面、CAPTCHA が出た場合はブラウザ上で人手対応し、その状態を local profile へ保存します。

```bash
BIC_PERSISTENT_USER_DATA_DIR=.playwright/profiles/bic-research HEADLESS=false npm run bic:profile
```

補足

- 既定の profile path は `.playwright/profiles/bic-research/` です
- `BIC_PERSISTENT_USER_DATA_DIR` を指定すると別ディレクトリへ保存できます
- `HEADLESS=false` で通常ブラウザに近い headful 実行にします
- ブラウザを閉じると profile が保存されます
- `BIC_SETUP_AUTO_CLOSE_MS=5000` のように指定すると、手元検証用に自動終了できます
- この script は定常スクレイピングの前提づくりではなく、人手診断専用です

### Bic browser mode / HTTP2 切り分け

通常の Playwright Chromium に加えて、system Chrome に近い実行モードや HTTP/2 切り分け用の起動 option を、`bic:profile` と `bic:probe-home` の診断で指定できます。

```bash
BIC_BROWSER_CHANNEL=chrome HEADLESS=false npm run bic:probe-home -- --fresh
```

```bash
BIC_DISABLE_HTTP2=true HEADLESS=false npm run bic:probe-home -- --fresh
```

補足

- `BIC_BROWSER_CHANNEL=chrome` は Playwright の `channel: 'chrome'` を使い、system Chrome に近い実行モードを試すためのものです
- `BIC_DISABLE_HTTP2=true` は `--disable-http2` を付け、`net::ERR_HTTP2_PROTOCOL_ERROR` の切り分けを行うためのものです
- 既定では Playwright の Chrome 起動に `--no-sandbox` を強制しません。sandbox を無効化しないと起動できない環境だけ `CHROMIUM_DISABLE_SANDBOX=true` を指定してください
- いずれも bot 検知回避のためではなく、診断時に通常ブラウザ利用に近い条件で挙動を確認するための option です

### Bic homepage probe

通る PC と通らない PC の差分を比較するため、Bic トップページの到達結果を JSON / HTML / PNG で保存する diagnostic probe script を追加しています。

```bash
HEADLESS=false BIC_BROWSER_CHANNEL=chrome npm run bic:probe-home
```

fresh profile で切り分けたい場合:

```bash
HEADLESS=false BIC_BROWSER_CHANNEL=chrome npm run bic:probe-home -- --fresh
```

補足

- 既定では persistent context で起動し、profile は `.playwright/profiles/bic-research/` を使います
- `--fresh` を付けるとその場限りの context で起動します
- `result.json` に DNS lookup、proxy 環境変数、response headers、Cookie 名、navigator 情報、HTTP status を保存します
- 既定の保存先は `playwright-artifacts/bic-home-probe/<timestamp>/` です
- `--url`、`--timeout-ms`、`--pause-ms`、`--output-dir` で挙動を調整できます
- 定常調査や定期スクレイピングではなく、環境差分の診断専用です

補足

- CAPTCHA や bot 検知を強引に突破する実装は行いません

legacy Bic record / offline parse で使う status の考え方:

- `ok`: 商品結果を取得できた
- `no_results`: 検索結果が見つからない
- `blocked`: CAPTCHA、403、429、access denied、bot/robot検知、アクセス集中表示など
- `transport_error`: HTTP/2 protocol error、TLS、ネットワーク transport 系
- `error`: timeout、selector error、その他の予期しない例外

### Bic 保存 HTML fallback

自動取得が難しい場合でも、手動で保存した Bic 検索結果 HTML から CSV / JSONL を生成できます。

```bash
npm run market:bic-parse-html -- --input path/to/bic-search.html --query "ポータブル エスプレッソマシン"
```

必要なら base URL や final URL を上書きできます。

```bash
npm run market:bic-parse-html -- --input path/to/bic-search.html --query "Nicoh Coffee" --base-url "https://www.biccamera.com/bc/category/?q=Nicoh+Coffee" --final-url "https://www.biccamera.com/bc/category/?q=Nicoh+Coffee"
```

この fallback は bot 検知を突破するためではなく、ブラウザで手動表示できた検索結果を後から市場調査データへ変換するための導線です。

補足

- `queries.official` は任意です
- `officialUrls` が空の場合は config エラーで停止します
- 404 / blocked / error でも URL ごとの証跡と JSONL / CSV record を残します
- CAPTCHA や bot 検知を強引に突破する実装は行いません

### config 形式

初期実装は JSON のみ対応です。

```json
{
	"project": "sample-market-research",
	"locale": "ja-JP",
	"timezone": "Asia/Tokyo",
	"viewport": {
		"width": 1920,
		"height": 1080
	},
	"headless": true,
	"officialUrls": [
		"https://example.com/",
		"https://example.com/nonexistent-market-product"
	],
	"queries": {
		"official": ["example domain overview", "missing example product page"],
		"amazon": [
			"Nicoh Coffee",
			"NK-H01",
			"NK-H01A",
			"ポータブル エスプレッソマシン",
			"ポータブル コーヒーメーカー",
			"電動 エスプレッソマシン ポータブル",
			"OutIn Nano",
			"Wacaco Nanopresso",
			"STARESSO"
		],
		"bic": [
			"Nicoh Coffee",
			"NK-H01",
			"NK-H01A",
			"ポータブル エスプレッソマシン",
			"ポータブル コーヒーメーカー"
		],
		"youtube": ["sample query"]
	},
	"loginStateLabel": "anonymous",
	"profileName": null,
	"outputFormats": ["csv", "jsonl"]
}
```

サンプル設定は `configs/market/sample.json` にあります。

Nicoh Coffee で使う場合の例:

```json
{
	"officialUrls": [
		"https://nicohcoffee.com/products/nk-h01",
		"https://nicohcoffee.com/products/nk-h01a",
		"https://nicohcoffee.com/products/nk-h02",
		"https://nicohcoffee.com/collections/all"
	]
}
```

### 出力先

- CSV / JSONL: `./output`
- 例: `output/market-smoke_2026-05-25_10-00-00.csv`
- 例: `output/market-smoke_2026-05-25_10-00-00.jsonl`

### 証跡保存先

市場調査用の証跡は以下へ保存します。

```text
playwright-artifacts/market-research/<project>/<target>/<timestamp>/
```

`market-official-site` は URL ごとのサブディレクトリを切ります。

```text
playwright-artifacts/market-research/<project>/market-official-site/<timestamp>/<url-slug>/
```

`market-amazon-search` は query ごとのサブディレクトリを切ります。

```text
playwright-artifacts/market-research/<project>/market-amazon-search/<timestamp>/<query-slug>/
```

保存内容

- `metadata.json`
- `page.html`
- `screenshot.png`
- エラー時: `error-metadata.json`
- エラー時: `error.html`
- エラー時: `error.png`
- 404 / blocked も証跡を保存します

### Playwright profile / storage state の扱い

- `.playwright/` と `playwright-artifacts/` は Git 管理対象外です
- `.playwright/profiles/`、storage state、Cookie、ログイン情報、2FA 情報は Git に含めないでください
- market 系ターゲットでも CAPTCHA や bot 検知を強引に突破する実装は行いません
- `market-amazon-search` も CAPTCHA / bot detection の bypass は行わず、block 時は証跡を保存して終了します
- Bic の live 調査は BrowserMCP 接続済みタブを前提とし、Playwright の通常検索 target としては公開しません
- Bic / Amazon の profile setup は human-in-the-loop 運用です。Amazon は検索 target へ再利用できますが、Bic は診断専用です
- `BIC_PERSISTENT_USER_DATA_DIR` や `AMAZON_PERSISTENT_USER_DATA_DIR` の保存先が Git 管理対象に入らないよう注意してください

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