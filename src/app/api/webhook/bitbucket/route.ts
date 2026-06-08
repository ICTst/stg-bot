import { createHmac, timingSafeEqual } from "node:crypto";
import { getRepoConfig } from "@/lib/config";
import { fetchDiff, fetchDiffStat } from "@/lib/bitbucket";
import { fetchIssue, type BacklogIssue } from "@/lib/backlog";

export const runtime = "nodejs"; // crypto（timingSafeEqual）を使うため Node ランタイムを明示
export const maxDuration = 60; // AI 生成（フェーズ3）を見込んだタイムアウト延長

// ---- Bitbucket push ペイロードの最小型（必要なフィールドのみ） ----
type PushChange = {
  new?: { type?: string; name?: string; target?: { hash?: string } } | null;
  old?: { target?: { hash?: string } } | null;
  created?: boolean;
  commits?: Array<{ message?: string }>;
  links?: { diff?: { href?: string } };
};

type BitbucketPushPayload = {
  repository?: { full_name?: string };
  push?: { changes?: PushChange[] };
};

/** 正規表現メタ文字をエスケープ（プロジェクトキーを正規表現に埋め込むため） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * X-Hub-Signature（"sha256=..."）を HMAC-SHA256 で検証する。
 * Secret 未設定時は開発用として検証をスキップ（true を返す）。
 */
function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.BITBUCKET_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[bitbucket-webhook] BITBUCKET_WEBHOOK_SECRET 未設定のため署名検証をスキップ");
    return true;
  }
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

function skip(reason: string) {
  console.log(`[bitbucket-webhook] スキップ: ${reason}`);
  return Response.json({ status: "skipped", reason }, { status: 200 });
}

export async function POST(request: Request) {
  try {
    // 1) 署名検証に必要なため、生テキストのまま読む
    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature");
    if (!verifySignature(rawBody, signature)) {
      console.warn("[bitbucket-webhook] 署名検証に失敗しました");
      return Response.json({ status: "invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(rawBody) as BitbucketPushPayload;

    // 2) 対象リポジトリか判定
    const fullName = payload.repository?.full_name;
    if (!fullName) return skip("repository.full_name がありません");
    const config = getRepoConfig(fullName);
    if (!config) return skip(`未登録のリポジトリ: ${fullName}`);

    // 3) 対象ブランチへの変更を探す
    const change = payload.push?.changes?.find(
      (c) => c.new?.type === "branch" && c.new?.name === config.targetBranch,
    );
    if (!change) return skip(`対象ブランチ(${config.targetBranch})への変更なし`);

    // 4) 新規ブランチ（old なし / created）はスキップ
    const newHash = change.new?.target?.hash;
    const oldHash = change.old?.target?.hash;
    if (change.created || !oldHash) return skip("新規ブランチのためスキップ");
    if (!newHash) return skip("new.target.hash がありません");

    // 5) コミットメッセージから課題キーを抽出（複数・重複排除）
    const commitMessages = (change.commits ?? [])
      .map((c) => c.message ?? "")
      .filter((m) => m.length > 0);
    const keyRegex = new RegExp(`${escapeRegExp(config.backlogProjectKey)}-\\d+`, "g");
    const issueKeys = [...new Set(commitMessages.join("\n").match(keyRegex) ?? [])];
    if (issueKeys.length === 0) {
      return skip(`課題キー(${config.backlogProjectKey}-NN)が見つかりません`);
    }

    // 6) Bitbucket diff/diffstat と Backlog 課題情報を並列取得
    const diffUrl = change.links?.diff?.href;
    if (!diffUrl) return skip("links.diff.href がありません");

    const [diffStat, diff, issues] = await Promise.all([
      fetchDiffStat(fullName, newHash, oldHash),
      fetchDiff(diffUrl),
      Promise.all(issueKeys.map((key) => fetchIssue(key))),
    ]);

    // 取得できた課題のみ（404 は null）
    const foundIssues = issues.filter((i): i is BacklogIssue => i !== null);

    // 7) フェーズ2: 投稿せず正規化結果をログ＆JSON で返す（AI生成=フェーズ3 / 投稿=フェーズ4）
    const dryRun = process.env.DRY_RUN !== "false"; // 既定は true（安全側）
    const normalized = {
      repoName: fullName,
      branch: config.targetBranch,
      newHash,
      oldHash,
      commitMessages,
      issueKeys,
      issues: foundIssues.map((i) => ({
        issueKey: i.issueKey,
        summary: i.summary,
      })),
      diffStat,
      diffPreview: diff.slice(0, 500),
      dryRun,
    };
    console.log("[bitbucket-webhook] 取得結果:", JSON.stringify(normalized, null, 2));

    // TODO(フェーズ3): generateMessage で依頼文を生成
    // TODO(フェーズ4): dryRun=false のとき foundIssues 各課題に postComment で投稿

    return Response.json({ status: "ok", ...normalized });
  } catch (err) {
    console.error("[bitbucket-webhook] エラー:", err);
    return Response.json(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
