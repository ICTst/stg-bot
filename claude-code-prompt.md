# STG Check Bot 実装依頼

## プロジェクトの目的

STGブランチへのpushをフックに、AIが変更内容(diff・コミット・Backlog課題)を読み取り、チェック担当者向けの「動作確認お願いします」コメントをBacklogに自動投稿するボットを作る。

現状は手動でBacklogに `@担当者 チェックお願いします` と書いており、これを自動化する。さらにAIで「変更内容の要約」「具体的なチェック観点」まで自動生成することで、手動時より依頼の品質を上げることがゴール。

社内のAI活用課題として7月末締め切り。まず1リポジトリで完成させ、設計上は他リポジトリ・他ホスティング(GitHub等)に横展開可能な構造にする。

## 全体フロー

```
stgブランチにpush
  → Bitbucket Webhook (repo:push) 発火
  → Next.js API Route (Vercelにデプロイ) が受信
  → 署名検証 (X-Hub-Signature / HMAC-SHA256)
  → 対象リポジトリ・対象ブランチか判定
  → Bitbucket APIでdiffstat + diff取得
  → コミットメッセージからBacklog課題キー(例: YAGI-123)を正規表現で抽出
  → Backlog APIで課題情報を取得
  → Vercel AI SDKでチェック依頼文を生成
  → Backlog APIで課題にコメント投稿(notifiedUserId[]で担当者へ通知)
  → Backlog⇔Chatwork連携(既存)により、Chatworkにも自動で通知が流れる
```

## 技術スタック

- Next.js (App Router) + TypeScript
- Vercel AI SDK (`ai` + `@ai-sdk/anthropic`)、モデルはClaude Sonnet
- デプロイ先: Vercel
- UIは不要(トップページは "running" 表示のみでよい)。Webhook受信用APIが本体

## ディレクトリ構成

```
src/
├── app/
│   ├── layout.tsx, page.tsx          # 最小限
│   └── api/webhook/bitbucket/route.ts # Webhook受信(POST)
└── lib/
    ├── config.ts          # リポジトリ毎の設定マッピング
    ├── bitbucket.ts       # Bitbucket APIクライアント
    ├── backlog.ts         # Backlog APIクライアント
    └── generateMessage.ts # AI生成ロジック
```

設計方針: ホスティング固有の処理(ペイロード解析・署名検証・diff取得)は入口で吸収し、`{ repoName, branch, commitMessages, diffStat, diff, issue }` という共通の形に正規化してから共通処理(AI生成→Backlog投稿)を呼ぶ。将来 `api/webhook/github/route.ts` を足すだけでGitHub対応できるようにする。

## 各モジュールの仕様

### config.ts

```ts
export const repoConfigs: Record<string, RepoConfig> = {
  "ictinc/yagimokuzai_erp": {
    targetBranch: "stg",        // 実際のSTGブランチ名(要確認)
    backlogProjectKey: "YAGI",  // 実際のプロジェクトキー(要確認)
    reviewerIds: [],            // チェック担当者のBacklogユーザーID(要確認)
  },
};
```

横展開時はここにエントリを足すだけで済む構造にする。

### route.ts(Webhook受信)

1. リクエストボディを**生テキストのまま**読み(署名検証に必要)、`X-Hub-Signature` ヘッダーとHMAC-SHA256で検証。比較は `crypto.timingSafeEqual` を使う。Secret未設定時は開発用として検証スキップ
2. `payload.repository.full_name` が `config.ts` に存在するかチェック。なければ200でスキップ応答
3. `payload.push.changes[]` から `new.type === "branch" && new.name === targetBranch` の変更を探す。なければスキップ
4. `new.target.hash` / `old.target.hash` を取得。oldが無い(新規ブランチ)場合はスキップ
5. `changes[].commits[].message` からコミットメッセージを収集し、`{projectKey}-\d+` で課題キーを抽出
6. Bitbucket APIでdiffstat・diff、Backlog APIで課題情報を並列取得(`Promise.all`)
7. AIで依頼文を生成
8. `DRY_RUN=true` のときはBacklogに投稿せず、生成結果をログ出力してJSONで返すのみ。`false` のとき課題コメントとして投稿
9. 課題キーが見つからない場合は投稿せずスキップ(ログに残す)
10. `export const maxDuration = 60;` を設定(AI生成の時間を考慮したVercelのタイムアウト延長)

### bitbucket.ts

- Bitbucket Cloud API 2.0、Basic認証(`BITBUCKET_USER`=Atlassianメールアドレス + `BITBUCKET_TOKEN`=APIトークン)
- `fetchDiffStat(repo, newHash, oldHash)`: `GET /2.0/repositories/{repo}/diffstat/{new}..{old}` → `{ status, path }[]`
- `fetchDiff(repo, newHash, oldHash, maxChars=20000)`: `GET /2.0/repositories/{repo}/diff/{new}..{old}` → 生diffテキスト。LLMのコンテキスト対策として maxChars で切り詰め、省略時はその旨を末尾に付記

### backlog.ts

- APIキー認証(クエリパラメータ `apiKey`)
- `fetchIssue(issueKey)`: `GET /api/v2/issues/{issueKey}` → 課題情報(404はnull)
- `postComment(issueKey, content, notifiedUserIds)`: `POST /api/v2/issues/{issueKey}/comments`、`application/x-www-form-urlencoded` で `content` と `notifiedUserId[]` を送る。本文への手書き@メンションではなく `notifiedUserId[]` で通知するのが確実(Chatwork連携にも乗る)

### generateMessage.ts(AIの心臓部)

`generateText`(Vercel AI SDK)で以下を含むプロンプトを投げる:

- 入力: リポジトリ/ブランチ、コミットメッセージ一覧、Backlog課題の件名と内容(2000字で切り詰め)、変更ファイル一覧、diff抜粋
- 出力要件:
  - Backlogコメントとしてそのまま投稿できる日本語
  - 構成: 挨拶1行 → 変更内容の要約(非エンジニアにも分かる言葉で2〜4行)→ 確認してほしい観点(具体的な操作手順を含む箇条書き3〜6個)→ 締めの一言
  - diffから読み取れないことは断定しない
  - 専門用語を避け、画面名・機能名ベースで書く
  - 前置きなしでコメント本文のみを出力

プロンプトは実際のdiffで試しながら調整するので、変更しやすいよう1ファイルに分離しておく。

## 環境変数(.env.example も作る)

```
BITBUCKET_WEBHOOK_SECRET=  # Webhook設定時に決めるランダム文字列
BITBUCKET_USER=            # Atlassianメールアドレス
BITBUCKET_TOKEN=           # Atlassian APIトークン
BACKLOG_SPACE_URL=         # 例: https://xxx.backlog.jp(末尾スラッシュなし)
BACKLOG_API_KEY=
ANTHROPIC_API_KEY=
DRY_RUN=true               # trueの間はBacklog投稿せずログのみ
```

## 実装の進め方(この順で)

1. **フェーズ1: 素通しパイプライン** — Webhookを受けてペイロードをログ出力するだけのroute.tsを作りデプロイ。実際にstgへpushしてペイロード構造を確認
2. **フェーズ2: データ取得** — 署名検証、ブランチ判定、Bitbucket diff取得、Backlog課題取得を実装。DRY_RUNで動作確認
3. **フェーズ3: AI生成** — generateMessage.tsを実装し、実diffでプロンプトを調整
4. **フェーズ4: 本稼働** — DRY_RUN=false で投稿有効化、実運用テスト

## 注意事項・運用前提

- コミットメッセージにBacklog課題キーを含める運用が前提(例: `YAGI-123 入力チェック修正`)
- 誤投稿防止のため、DRY_RUNがtrueでない限り本投稿しないこと。デフォルトはtrue
- APIキー類は絶対にコードにハードコードしない。`.env.local` は .gitignore に含める
- エラー時は500を返しつつ詳細をログに残す(Vercel Functionsのログで追えるように)
- reviewerIdsの確認方法: `{BACKLOG_SPACE_URL}/api/v2/projects/{プロジェクトキー}/users?apiKey={キー}` で一覧取得できる

## 実装前に私(ユーザー)に確認してほしいこと

- 実際のSTGブランチ名(`stg` で合っているか)
- Backlogのプロジェクトキー
- チェック担当者のBacklogユーザーID
- BitbucketのWebhook Secretを設定したか
