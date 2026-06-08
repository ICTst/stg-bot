// Backlog API クライアント。
// APIキー認証（クエリパラメータ apiKey）。

function spaceUrl(): string {
  const url = process.env.BACKLOG_SPACE_URL;
  if (!url) throw new Error("BACKLOG_SPACE_URL が未設定です");
  return url.replace(/\/+$/, ""); // 末尾スラッシュを除去
}

function apiKey(): string {
  const key = process.env.BACKLOG_API_KEY;
  if (!key) throw new Error("BACKLOG_API_KEY が未設定です");
  return key;
}

export type BacklogIssue = {
  id: number;
  issueKey: string;
  summary: string;
  description: string;
};

/**
 * 課題情報を取得する。
 * GET /api/v2/issues/{issueKey}
 * 課題が存在しない（404）場合は null を返す。
 */
export async function fetchIssue(issueKey: string): Promise<BacklogIssue | null> {
  const url = `${spaceUrl()}/api/v2/issues/${encodeURIComponent(issueKey)}?apiKey=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Backlog 課題取得失敗 ${issueKey} (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    id: number;
    issueKey: string;
    summary?: string;
    description?: string;
  };
  return {
    id: data.id,
    issueKey: data.issueKey,
    summary: data.summary ?? "",
    description: data.description ?? "",
  };
}

/**
 * 課題にコメントを投稿する。
 * POST /api/v2/issues/{issueKey}/comments（application/x-www-form-urlencoded）
 * 本文への手書き @メンションではなく notifiedUserId[] で通知するのが確実（Chatwork 連携にも乗る）。
 * ※ フェーズ4で結線する。フェーズ2・3 では未使用。
 */
export async function postComment(
  issueKey: string,
  content: string,
  notifiedUserIds: number[] = [],
): Promise<void> {
  const url = `${spaceUrl()}/api/v2/issues/${encodeURIComponent(issueKey)}/comments?apiKey=${encodeURIComponent(apiKey())}`;
  const params = new URLSearchParams();
  params.set("content", content);
  for (const id of notifiedUserIds) {
    params.append("notifiedUserId[]", String(id));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Backlog コメント投稿失敗 ${issueKey} (${res.status}): ${body}`);
  }
}
