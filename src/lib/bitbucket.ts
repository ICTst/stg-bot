// Bitbucket Cloud API 2.0 クライアント。
// Basic 認証（BITBUCKET_USER=Atlassian メールアドレス + BITBUCKET_TOKEN=API トークン）。

const API_BASE = "https://api.bitbucket.org/2.0";

function authHeader(): string {
  const user = process.env.BITBUCKET_USER;
  const token = process.env.BITBUCKET_TOKEN;
  if (!user || !token) {
    throw new Error("BITBUCKET_USER / BITBUCKET_TOKEN が未設定です");
  }
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return `Basic ${basic}`;
}

export type DiffStatEntry = {
  /** added | modified | removed | renamed など */
  status: string;
  /** 変更後パス（無ければ変更前パス） */
  path: string;
};

type BitbucketDiffStatResponse = {
  values?: Array<{
    status?: string;
    new?: { path?: string } | null;
    old?: { path?: string } | null;
  }>;
  next?: string;
};

/**
 * diffstat（変更ファイル一覧）を取得する。
 * GET /2.0/repositories/{repo}/diffstat/{new}..{old}
 * ※ MVP では先頭1ページのみ取得（pagelen=500）。大量変更時は next を辿らない。
 */
export async function fetchDiffStat(
  repo: string,
  newHash: string,
  oldHash: string,
): Promise<DiffStatEntry[]> {
  const url = `${API_BASE}/repositories/${repo}/diffstat/${newHash}..${oldHash}?pagelen=500`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitbucket diffstat 取得失敗 (${res.status}): ${body}`);
  }
  const data = (await res.json()) as BitbucketDiffStatResponse;
  return (data.values ?? []).map((v) => ({
    status: v.status ?? "unknown",
    path: v.new?.path ?? v.old?.path ?? "(unknown path)",
  }));
}

/**
 * 生 diff テキストを取得する。
 * ペイロード同梱の diff URL（changes[].links.diff.href, 形式は {new}..{old}）をそのまま使う。
 * LLM のコンテキスト対策として maxChars で切り詰め、省略時は末尾に注記する。
 */
export async function fetchDiff(diffUrl: string, maxChars = 20000): Promise<string> {
  const res = await fetch(diffUrl, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitbucket diff 取得失敗 (${res.status}): ${body}`);
  }
  const text = await res.text();
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n…（diff が長いため ${maxChars} 文字で切り詰めました。全体は ${text.length} 文字）`
  );
}
