# ashiato — 足跡アルバム

ashiato は、GPSの足跡・お気に入りスポットを地図に記録し、写真や動画をGoogle Driveに保存するWebアプリです。Web版はGitHubでソースを管理し、Cloudflare PagesとGoogle Apps Script (GAS) で公開・同期します。

## ドキュメント

- [利用者向け操作説明書](./docs/操作説明書.md)
- [構成・開発引継ぎ書](./docs/構成・開発引継ぎ.md)

## 技術構成

- **Web画面**: React 19、TypeScript、Vite、Leaflet
- **公開/API**: GitHub、Cloudflare Pages、Pages Functions
- **アカウント・同期DB**: GAS、Googleスプレッドシート
- **写真・動画**: Google Drive API。ファイル本体はDrive、参照情報はアプリデータとスプレッドシートに保存
- **PWA**: ホーム画面への追加とアプリシェルのキャッシュ
- **モバイル基盤**: CapacitorのAndroid／iOSプロジェクトを含む。メールアカウント認証を含む運用対象はWeb版

## ローカル開発

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Viteの開発サーバーだけではCloudflare Pages Functionsが動きません。GASを含む認証・同期をローカルで確認する場合は、`.dev.vars.example` を `.dev.vars` に複製して値を設定し、`npm run build` の後に `npx wrangler pages dev dist` を実行してください。詳細な設定とデプロイ手順は[構成・開発引継ぎ書](./docs/構成・開発引継ぎ.md)を参照してください。

## 基本コマンド

```sh
npm run dev
npm run lint
npm run build
npm run cap:sync
```

ブラウザー版のGPSにはHTTPS（またはlocalhost）と位置情報の許可が必要です。ページを閉じた後のWeb GPS記録は保証されません。GPSの記録間隔は10秒・30秒・1分から選択できます。地図タイルはOpenStreetMapを利用し、地図表示にはネットワーク接続が必要です。
