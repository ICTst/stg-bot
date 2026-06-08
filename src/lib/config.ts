// リポジトリ毎の設定マッピング。
// 横展開時はこの repoConfigs にエントリを足すだけで対応できる。

export type RepoConfig = {
  /** フック対象ブランチ名（このブランチへの push のみ処理する） */
  targetBranch: string;
  /** Backlog の課題キー接頭辞（課題キー抽出の正規表現に使う。例: YAGI_MOKUZAI_ERP） */
  backlogProjectKey: string;
  /** チェック担当者の Backlog 数値ユーザーID（コメント通知先。フェーズ4で使用） */
  reviewerIds: number[];
};

export const repoConfigs: Record<string, RepoConfig> = {
  "ictinc/yagimokuzai_erp": {
    targetBranch: "phase3",
    backlogProjectKey: "YAGI_MOKUZAI_ERP",
    reviewerIds: [], // TODO(フェーズ4): Backlog の数値ユーザーIDを設定する
  },
};

/** full_name から設定を引く。未登録なら undefined */
export function getRepoConfig(fullName: string): RepoConfig | undefined {
  return repoConfigs[fullName];
}
