# ashiato — 足跡アルバム

訪れた場所をGPSで記録し、思い出の写真・動画と一緒に地図へ残すWebアプリです。スマートフォンのブラウザーから使え、ホーム画面にも追加できます。

## 構成

- **GitHub**: ソースコード管理。GitHubへpushし、Cloudflare Pagesからリポジトリを接続して公開します。
- **Cloudflare Pages**: ReactのWeb画面を配信し、`functions/` のAPIでGASへのリクエストを中継します。
- **Google Apps Script (GAS)**: Google IDトークンを検証し、利用者ごとに分けたGPS・スポット情報をGoogleスプレッドシートへ保存します。
- **Capacitor**: 必要に応じて、同じ画面をiOS／Androidアプリとして実行します。Web利用にはネイティブアプリのインストールは不要です。
- **Google Drive API**: ログインした利用者本人のDriveへ写真・動画を保存します。アプリはファイル本体ではなくDrive上の参照情報を同期します。

GPS記録は初期状態で10秒ごとです。設定画面から10秒・30秒・1分を選べます。設定間隔は記録する頻度を変えますが、GPSの電池消費は端末・OS・測位条件によって変わり、一定の節電を保証するものではありません。記録を停止しても、すでに端末に保存された足跡は残ります。

## 初回セットアップ

### 1. ローカルで画面を起動

```sh
npm install
copy .env.example .env.local
npm run dev
```

Googleログイン・同期には後述のGoogle OAuth設定が必要です。設定前も画面、地図、GPS、スポット保存を試せます。ブラウザーでのGPS利用にはHTTPS（またはlocalhost）が必要です。Web版ではページを開いている間にGPSを記録します。画面ロック中やブラウザーを閉じた後の継続は保証されません。公開後はスマートフォンのブラウザーメニューから「ホーム画面に追加」を選び、アプリ風に起動できますが、GPSのバックグラウンド制約は同じです。

### 2. Google CloudのOAuth設定

1. Google Cloudでプロジェクトを作り、OAuth同意画面を設定します。
2. **ウェブアプリケーション**のOAuthクライアントを作成します。Web版のGoogleログインとDrive連携に使用します。同じクライアントをネイティブアプリのOAuthコード交換にも使えます。
3. 承認済みのJavaScript生成元に `http://localhost:5173` とCloudflare Pagesのドメインを追加します。
4. ネイティブアプリのGoogleログインも使う場合は、承認済みのリダイレクトURIに `https://<Pagesのドメイン>/api/oauth/callback` を追加します。
5. Google Drive APIを有効にします。Driveへの書き込み権限は `drive.file` のみを要求します。
6. `.env.local` の `VITE_GOOGLE_CLIENT_ID` を設定します。ネイティブ版を作る前に `VITE_API_BASE_URL` もPagesのHTTPS URLに設定してください。

OAuthクライアントシークレットはCloudflareのシークレットとしてのみ登録し、`.env.local` やGitHubには保存しないでください。

### 3. GASと利用者別データベース

1. Googleスプレッドシートを1つ作り、そのIDを控えます。初回実行時に `Points` と `Spots` シートが自動作成されます。
2. Apps Scriptプロジェクトに `gas/Code.gs` の内容を追加します。
3. Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に次を追加します。
   - `SPREADSHEET_ID`: 作成したスプレッドシートのID
   - `GOOGLE_CLIENT_ID`: Google CloudのOAuthクライアントID
4. `doPost` をウェブアプリとしてデプロイし、実行ユーザーは自分、アクセスできるユーザーは全員に設定します。APIは公開URLを持ちますが、GPS情報の読み書きにはサーバー側で検証するGoogle IDトークンが必須です。
5. デプロイ後の `/exec` URLをCloudflare Pagesの環境変数 `GAS_EXEC_URL` に登録します。

スプレッドシートはアプリ運営者のGoogleアカウントに保存されます。記録の各行は検証済みGoogleアカウントの不変なユーザーIDで分離され、別ユーザーの行は読み出されません。

### 4. Cloudflare Pagesへ公開

GitHubにpushした後、Cloudflare Pagesでこのリポジトリを接続します。

- ビルドコマンド: `npm run build`
- 出力ディレクトリ: `dist`
- 環境変数:
  - `GAS_EXEC_URL`
  - `APP_ORIGIN` (Cloudflare Pages URL。カスタムドメインで公開する場合はアプリの公開URL)
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_REDIRECT_URI` (`https://<Pagesのドメイン>/api/oauth/callback`)
- シークレット:
  - `GOOGLE_CLIENT_SECRET`

OAuth関連の値はProductionとPreviewの両環境に登録します。ネイティブアプリをビルドする場合は `.env.local` の `VITE_API_BASE_URL` にそのPages URLを指定します。ローカルでPages Functionsも含めて動かすには `.dev.vars.example` を `.dev.vars` にコピーして値を設定し、`npm run build` 後に `npx wrangler pages dev dist` を実行します。

### 5. iOS／Androidアプリをビルド

ネイティブプロジェクトは `android/` と `ios/` にあります。

```sh
npm run cap:sync
npm run android
npm run ios
```

AndroidはAndroid Studio／Android SDKが必要です。iOSアプリのビルドと署名にはmacOSとXcodeが必要です。Windows上ではiOSプロジェクトを編集できますが、iOSアプリ自体はビルドできません。

実機では、iOSは位置情報の「常に許可」を選び、Androidは位置情報とバックグラウンド記録中の通知を許可してください。Androidではアプリを前面に開いた状態で記録を開始してから、画面を閉じて動作を確認します。OSの省電力設定、端末メーカーによるアプリ停止、アプリの強制終了などにより、記録が中断・遅延することがあります。特にiOSではアプリを明示的に強制終了した後の記録継続は保証されません。アプリを閉じた状態を含むGPS精度・電池消費を、両OSの実機で確認してください。

## ローカル開発コマンド

```sh
npm run dev
npm run lint
npm run build
npm run cap:sync
```

地図タイルはOpenStreetMapを利用します。ネットワーク接続が必要で、地図上に帰属表示が出ます。
