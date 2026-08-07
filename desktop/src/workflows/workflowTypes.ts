export type ReviewWorkflowStatus =
  | "draft"
  | "awaiting_plan_approval"
  | "running"
  | "waiting_user"
  | "revision_required"
  | "completed";

export type ScoutAutomationStatus = "idle" | "running" | "paused" | "completed";

export type ReviewWorkflowStageStatus =
  | "not_started"
  | "ready"
  | "in_progress"
  | "waiting_user"
  | "waiting_reviewer"
  | "revision_required"
  | "blocked"
  | "partial"
  | "passed";

export type ReviewerGateStatus =
  | "not_required"
  | "pending"
  | "approved"
  | "rejected"
  /** Ran with independent review switched off. Never conflate with "approved". */
  | "skipped";
export type ReviewCountBranch = "unknown" | "insufficient" | "focused" | "broad";

export interface ReviewWorkflowCreateInput {
  topic: string;
  keywords: string[];
  languages: string[];
  databases: string[];
  yearFrom: number;
  yearTo: number;
}

export interface ReviewSearchQuery {
  id: string;
  source: string;
  kind: string;
  language: string;
  query: string;
  rationale: string;
}

export interface ReviewSearchPlan {
  queries: ReviewSearchQuery[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  generatedBy: string;
  generatedAt: string;
}

export interface WorkflowContextPolicy {
  abstractBatchSize: number;
  abstractCharsPerRecord: number;
  synthesisInputChars: number;
  fullTextStrategy: string;
}

export interface WorkflowSourceCoverage {
  source: string;
  status: string;
  totalHits?: number;
  fetched: number;
  unique: number;
  exhausted: boolean;
  nextCursor?: string;
  truncatedReason?: string;
  failureMessage?: string;
}

export interface WorkflowCoverage {
  totalHits?: number;
  fetched: number;
  unique: number;
  exhausted: boolean;
  nextCursor?: string;
  truncatedReason?: string;
  skippedSources: string[];
  failedSources: string[];
  sourceAttempts: WorkflowSourceCoverage[];
}

export interface PrimaryPathAllocation {
  id: "abc" | "ab" | "bc" | "ac";
  /** Hard external-retrieval budget assigned to this matrix path. The four
   * allocations sum to the user-approved total and are never multiplied. */
  maxResults: number;
  rationale: string;
}

/** How one matrix path spent its retrieval budget.
 *
 * `candidateRecordIds` is everything retrieval attributed to the path,
 * `admittedRecordIds` is the relevant subset in retrieval order, and
 * `deferredRecordIds` is the auditable remainder. A deferred record is retained
 * and reportable, never silently dropped. */
export interface PrimaryPathAdmission {
  pathId: "abc" | "ab" | "bc" | "ac";
  quota: number;
  candidateRecordIds: string[];
  admittedRecordIds: string[];
  deferredRecordIds: string[];
  /** Set when the path admitted fewer records than its quota, explaining why. */
  shortfallReason?: string;
  selectedAt: string;
  method: string;
}

/** One candidate's binary verdict inside the primary-library screening
 * batch. Path attribution and the final admitted flag are added after the
 * batch, so they are deliberately absent here. */
export interface PrimaryScoredCandidate {
  recordId: string;
  relevant?: boolean;
  /** Legacy Stage 09 checkpoints used A/B/C/D before screening was simplified. */
  grade?: string;
  rationale: string;
}

/** Per-candidate relevance evidence behind one admission decision. */
export interface PrimaryCandidateScore {
  recordId: string;
  pathId: "abc" | "ab" | "bc" | "ac";
  relevant: boolean;
  /** Retained only when loading an older run. Formal grades live in paperGrades. */
  grade?: "A" | "B" | "C" | "D" | string;
  keyFinding?: string;
  rationale: string;
  /** Legacy audit fields retained for wire compatibility. */
  citationCount?: number;
  year?: number;
  admitted: boolean;
}

export interface ReviewEligibilitySummary {
  candidateRecordIds: string[];
  eligibleRecordIds: string[];
  excludedRecordIds: string[];
  missingAbstractRecordIds: string[];
  complete: boolean;
  method: string;
  screenedAt?: string;
}

export interface ReviewDirection {
  id: string;
  title: string;
  gap: string;
  outline: string;
  workload: string;
  difficulty: string;
  feasibility: string;
  evidenceRecordIds: string[];
}

export interface ReviewLandscapeAnalysis {
  developmentStatus: string;
  majorProblems: string[];
  newcomerNotes: string[];
  temporalTrends: string[];
  topicEvolution: string[];
  reviewGaps: string[];
  directions: ReviewDirection[];
  generatedAt: string;
  generatedBy: string;
}

export interface MatrixConcept {
  role: "A" | "B" | "C" | string;
  entity: string;
  rationale: string;
  terms: string[];
}

export interface MatrixSearchPath {
  id: string;
  combination: string;
  target: string;
  strategicIntent: string;
  query: string;
  actionGuide: string;
  expectedResults: string;
  reviewValue: string;
}

export interface MatrixSearchStrategy {
  mode: "stable" | "expanded" | string;
  concepts: MatrixConcept[];
  paths: MatrixSearchPath[];
  exclusionAdvice: string;
  exclusionQuery?: string;
  syntaxChecks: string[];
  generatedAt: string;
  generatedBy: string;
}

export interface QueryQualityIteration {
  id: string;
  iteration: number;
  pathId: string;
  query: string;
  sampleRecordIds: string[];
  sampleSize: number;
  relevantCount: number;
  lowRelevanceCount: number;
  estimatedPrecision: number;
  falsePositivePatterns: string[];
  adjustmentDirections: string[];
  recommendation: string;
  /** Independent-review provenance for this exact pilot round. Optional for
   *  runs created before the retrieve-inspect-revise loop persisted it. */
  reviewerStatus?: "approved" | "rejected" | "skipped";
  reviewerSummary?: string;
  reviewerIssues?: string[];
  /** Deterministic failures (for example the 50% precision floor) are kept
   *  separate from model-review issues so a disabled Reviewer is never
   *  presented as having rejected the stage. */
  qualityIssues?: string[];
  reviewerApproved: boolean;
  createdAt: string;
}

export interface WorkflowPaperGrade {
  recordId: string;
  originalIndex: number;
  grade: "A" | "B" | "C" | "D" | string;
  keyFinding: string;
  rationale: string;
  method: string;
}

export interface WorkflowOutlineSection {
  id: string;
  title: string;
  purpose: string;
  /** Papers whose findings produced this section, carried from the theme
   *  digests. A body section without them is a template heading, not a
   *  data-driven one. Absent on runs created before the outline carried it. */
  recordIds?: string[];
  children: WorkflowOutlineSection[];
}

export interface WorkflowPaperMapping {
  recordId: string;
  originalIndex: number;
  zoteroLocator: string;
  directSectionId?: string;
  indirectSectionId?: string;
  contribution: string;
}

export type WorkflowBatchJobKind =
  | "eligibility"
  | "landscape"
  | "grading"
  | "mapping"
  | "outline"
  | "query_quality"
  | "primary-select";

export interface WorkflowLandscapeDigest {
  summary: string;
  themes: string[];
  problems: string[];
  trends: string[];
  gaps: string[];
  evidenceRecordIds: string[];
}

export interface WorkflowOutlineDigest {
  themes: Array<{ name: string; claims: string[]; recordIds: string[] }>;
  transitions: string[];
  evidenceGaps: string[];
  /** Where the papers disagree. A review has to report the disagreement, so it
   *  needs somewhere to survive the digest step. */
  contested?: string[];
}

/** A durable cross-batch topic cluster. It is the visible evidence structure
 * the Executor uses to make an outline; it must survive after the transient
 * batch checkpoint is cleared. */
export interface WorkflowOutlineCluster {
  id: string;
  title: string;
  claim: string;
  recordIds: string[];
  evidenceGaps: string[];
  contested: string[];
}

/** Results of the batches finished so far. Staged here rather than in the
 *  canonical run fields because a half-finished job would violate one-to-one
 *  coverage invariants. */
export type WorkflowBatchPartial =
  | { kind: "eligibility"; decisions: Array<{ recordId: string; eligible: boolean }> }
  | { kind: "landscape"; digests: WorkflowLandscapeDigest[] }
  | { kind: "grading"; grades: WorkflowPaperGrade[] }
  | { kind: "mapping"; mappings: WorkflowPaperMapping[] }
  | { kind: "outline"; digests: WorkflowOutlineDigest[] }
  | { kind: "query_quality"; judgments: WorkflowPilotJudgment[] }
  | { kind: "primary-select"; scores: PrimaryScoredCandidate[] };

/** One pilot record's relevance verdict, staged per batch so an interrupted
 *  false-positive analysis resumes instead of re-judging every record. */
export interface WorkflowPilotJudgment {
  recordId: string;
  relevant: boolean;
  reason: string;
  cause: string;
}

export interface WorkflowBatchCheckpoint {
  kind: WorkflowBatchJobKind;
  stageId: string;
  /** Digest of the ordered inputs plus batch policy; a mismatch on resume
   *  discards the checkpoint instead of merging stale results. */
  inputFingerprint: string;
  batchSize: number;
  completedBatches: number;
  totalBatches: number;
  partial: WorkflowBatchPartial;
  updatedAt: string;
}

export interface ReviewerGate {
  required: boolean;
  status: ReviewerGateStatus;
  reviewer?: string;
  summary?: string;
  issues: string[];
  reviewedAt?: string;
}

export interface ReviewWorkflowStage {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  status: ReviewWorkflowStageStatus;
  reviewerGate: ReviewerGate;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
}

export interface WorkflowArtifact {
  id: string;
  kind: string;
  title: string;
  uri: string;
  createdAt: string;
}

export interface WorkflowEvent {
  sequence: number;
  timestamp: string;
  actor: string;
  action: string;
  summary: string;
  stageId?: string;
}

/** One finished model call, kept so a stage can be reviewed after the fact.
 *  The live feed is in-memory and dies with the session; this is the record. */
export interface WorkflowActivityEntry {
  id: string;
  stageId: string;
  actor: string;
  title: string;
  model?: string;
  status: "completed" | "failed";
  /** Raw model output, or the error for a failed call. Truncated on write. */
  detail?: string;
  startedAt: string;
  completedAt: string;
}

export type WorkflowLiveActivityStatus = "running" | "completed" | "failed";

/** In-memory portion of the same transcript while an Executor, Reviewer, or
 * search call is still producing output. */
export interface WorkflowLiveActivity {
  id: string;
  stageId?: string;
  actor: "Executor" | "Independent Reviewer" | "Search";
  title: string;
  phase?: string;
  reasoning?: string;
  detail?: string;
  model?: string;
  status: WorkflowLiveActivityStatus;
  updatedAt: string;
}

/** Exclusive right to drive one run, held by a single batched job or loop. */
export interface RunLease {
  ownerTurnId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ReviewWorkflowRun {
  protocolVersion: number;
  id: string;
  templateId: string;
  templateVersion: number;
  revision: number;
  /** Durable chat session carrying this run's conversation. */
  sessionId?: string;
  /** Held while a batched job or controller loop is driving this run. */
  lease?: RunLease;
  title: string;
  topic: string;
  keywords: string[];
  languages: string[];
  databases: string[];
  yearFrom: number;
  yearTo: number;
  /** Verified Executor selected for this workflow; undefined uses Settings' current model. */
  executorModel?: string;
  /** Switches off the separate reviewer model for this run: gates record
   *  `skipped` instead of `approved`, and the classification steps that normally
   *  run on the reviewer fall back to the Executor. */
  reviewerDisabled?: boolean;
  contextPolicy: WorkflowContextPolicy;
  status: ReviewWorkflowStatus;
  activeStageId: string;
  planApproved: boolean;
  /** Persisted controller state for the first user-facing macro step. */
  scoutAutomationStatus?: ScoutAutomationStatus;
  scoutPauseReason?: string;
  scoutRevisionLimit?: number;
  reviewSearchIteration: number;
  searchRevisionReason?: string;
  previousEligibleReviewCount?: number;
  searchPlan?: ReviewSearchPlan;
  searchProtocolId?: string;
  searchRunId?: string;
  searchRecordIds: string[];
  coverage?: WorkflowCoverage;
  reviewEligibility: ReviewEligibilitySummary;
  reviewCountBranch: ReviewCountBranch;
  landscapeAnalysis?: ReviewLandscapeAnalysis;
  selectedDirectionId?: string;
  matrixStrategy?: MatrixSearchStrategy;
  matrixPlanApproved: boolean;
  matrixSearchProtocolId?: string;
  matrixSearchRunId?: string;
  matrixSearchPathId?: string;
  matrixRecordIds: string[];
  matrixCoverage?: WorkflowCoverage;
  queryQualityIterations: QueryQualityIteration[];
  primarySearchProtocolId?: string;
  primarySearchRunId?: string;
  /** Hard external-retrieval budget requested by the user. Deduplication and
   * binary relevance screening may produce a smaller final admitted corpus. */
  primaryTargetResults: number;
  /** Executor-selected split of the user-approved external retrieval budget. */
  primaryPathAllocations?: PrimaryPathAllocation[];
  /** Everything retrieval attributed to each matrix path, keyed by path id.
   * Retrieval fills these; binary screening turns them into admissions. */
  primaryPathCandidates?: Record<string, string[]>;
  /** Quota spend per matrix path. `primaryRecordIds` is its admitted union. */
  primaryPathAdmissions?: PrimaryPathAdmission[];
  /** Audit trail for the binary screening that produced the admissions. */
  primaryCandidateScores?: PrimaryCandidateScore[];
  primaryRecordIds: string[];
  primaryCoverage?: WorkflowCoverage;
  paperGrades: WorkflowPaperGrade[];
  /** Theme clusters constructed from A/B evidence before outline generation. */
  outlineClusters: WorkflowOutlineCluster[];
  /** Input identity for the clusters, so a changed grade set cannot reuse them. */
  outlineClusterFingerprint?: string;
  outline: WorkflowOutlineSection[];
  paperMappings: WorkflowPaperMapping[];
  /** Present only while a batched model job is unfinished. */
  batchCheckpoint?: WorkflowBatchCheckpoint;
  stages: ReviewWorkflowStage[];
  artifacts: WorkflowArtifact[];
  events: WorkflowEvent[];
  /** Durable transcript of the Executor/Reviewer calls behind each stage. */
  activityLog?: WorkflowActivityEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewWorkflowSummary {
  id: string;
  title: string;
  topic: string;
  status: ReviewWorkflowStatus;
  activeStageId: string;
  revision: number;
  updatedAt: string;
}

export interface ReviewWorkflowSaveInput {
  expectedRevision: number;
  run: ReviewWorkflowRun;
  actor: string;
  action: string;
  summary: string;
  stageId?: string;
  /**
   * Proof that this writer holds the run's lease, when one is held. Echoing
   * `run.lease` back is not proof — any reader has it — so the owner id has to
   * travel out-of-band.
   */
  leaseOwnerTurnId?: string;
}

export interface LiteratureQueryVariant {
  kind: string;
  query: string;
  rationale: string;
  maxResults?: number;
}

export interface LiteratureProtocolPreview {
  protocol: {
    id: string;
    revision: number;
    maxResults?: number;
  };
  plan: Array<{
    source: string;
    query: string;
    queryVariants: LiteratureQueryVariant[];
    queryVariantPlan?: Array<LiteratureQueryVariant & {
      maxResults: number;
      willExecute: boolean;
    }>;
    maxResults: number;
    sortOrder?: string;
    adapterStatus: string;
    coverageNote: string;
  }>;
  maxResults: number;
}

export interface LiteratureProtocolExecution {
  searchRun: {
    id: string;
    status: string;
    recordIds: string[];
    /** Per-record provider and query-variant attribution, when the kernel run
     * carried it. `variantRanks` is the record-to-matrix-path link. */
    rankedRecords?: Array<{
      recordId: string;
      sourceRanks?: Record<string, number>;
      variantRanks?: Record<string, number>;
      fusedScoreMicros?: number;
    }>;
    sourceAttempts: Array<{
      source: string;
      status: string;
      returnedCount: number;
      coverage: {
        totalHits?: number;
        fetched: number;
        unique: number;
        exhausted: boolean;
        nextCursor?: string;
        truncatedReason?: string;
      };
      failureMessage?: string;
    }>;
  };
  warnings: string[];
}
