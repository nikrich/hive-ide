/** Live GitHub data for one PR card (PRs view enrichment). */
export interface PrEnrichment {
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  additions: number;
  deletions: number;
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  /** Rollup of the head commit's checks; null when the PR has no checks. */
  checks: 'passing' | 'failing' | 'pending' | null;
}
