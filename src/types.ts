import type { RepoPathDeclaration } from './parallel-paths.js'

export type JsonSchema = {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly additionalProperties?: boolean
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly const?: string | number | boolean | null
  readonly minimum?: number
  readonly maximum?: number
  readonly maxItems?: number
  readonly minItems?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly oneOf?: readonly JsonSchema[]
  readonly allOf?: readonly JsonSchema[]
  readonly contains?: JsonSchema
  readonly if?: JsonSchema
  readonly not?: JsonSchema
  readonly then?: JsonSchema
}

export type SchedulingTargetV1 = 'root' | 'worker'

/** Durable event branch expected by a contextual replay/parser consumer. */
export type ExpectedEventBranch = 'legacy' | 'parallel'

/** Correlation fields shared by parallel worker and worker-target schedule events. */
export interface CorrelationTripleV1 {
  readonly fanoutId: string
  readonly nodeId: string
  readonly requestId: string
}

export interface VerificationEvidenceV1 {
  readonly schemaVersion: 1
  readonly commandName: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly status: 'passed' | 'failed' | 'timed-out' | 'spawn-error'
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly durationMs: number
}

export interface HandoffV1 {
  readonly schemaVersion: 1
  readonly status: 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly decisions: readonly string[]
  readonly verification: readonly VerificationEvidenceV1[]
  readonly blockers: readonly string[]
}

export interface CapabilityProfileV1 {
  readonly coding: number
  readonly reasoning: number
  readonly toolUse: number
  readonly repoContext: number
  readonly risk: number
  readonly difficulty: number
}

export interface SchedulingConstraintsV1 {
  readonly maxWorkers: number
  readonly maxOutputTokens: number
  readonly maxLatencyMs: number
  readonly allowPaidFallback: boolean
  readonly allowedProviders?: readonly string[]
  readonly requiredTools: readonly string[]
}

export interface TaskNodeV1 {
  readonly schemaVersion: 1
  readonly nodeId: string
  readonly objective: string
  readonly profile: CapabilityProfileV1
  readonly constraints: SchedulingConstraintsV1
  readonly readPaths: readonly RepoPathDeclaration[]
  readonly writePaths: readonly RepoPathDeclaration[]
  readonly dependsOn: readonly string[]
}

export interface TaskDagV1 {
  readonly schemaVersion: 1
  readonly rootTaskId: string
  readonly nodes: readonly TaskNodeV1[]
}

export interface DagValidationLimitsV1 {
  readonly schemaVersion: 1
  readonly maxNodes: number
  readonly maxLevels: number
  readonly maxWidth: number
  readonly maxCumulativeWorkers: number
}

export type DagValidationIssueV1 =
  | { readonly code: 'duplicate-node'; readonly nodeId: string }
  | { readonly code: 'self-dependency'; readonly nodeId: string }
  | { readonly code: 'missing-dependency'; readonly nodeId: string; readonly dependsOn: string }
  | { readonly code: 'cycle'; readonly nodeId: string }
  | { readonly code: 'overlapping-access'; readonly nodeA: string; readonly nodeB: string; readonly mode: 'ww' | 'wr' | 'rw' }
  | { readonly code: 'too-many-nodes'; readonly count: number; readonly limit: number }
  | { readonly code: 'too-many-levels'; readonly levelCount: number; readonly limit: number }
  | { readonly code: 'level-width-exceeded'; readonly level: number; readonly width: number; readonly limit: number }
  | { readonly code: 'cumulative-worker-limit-exceeded'; readonly count: number; readonly limit: number }

export interface DagValidationV1 {
  readonly schemaVersion: 1
  readonly valid: boolean
  readonly issues: readonly DagValidationIssueV1[]
  readonly levels: readonly (readonly string[])[]
  readonly levelCount: number
}

export interface ParallelVerificationCommandV1 {
  readonly name: string
  readonly args: readonly string[]
}

export interface ParallelVerificationPolicyV1 {
  readonly schemaVersion: 1
  readonly scope: 'level' | 'dag'
  readonly commands: readonly ParallelVerificationCommandV1[]
}

export type VerificationOutcomeV1 =
  | 'not-run-no-commands'
  | 'not-run-no-accepted-nodes'
  | 'passed'
  | 'command-failed'
  | 'admission-rejected'

export type NodeOutcomeReasonV1 =
  | 'dependency-not-run'
  | 'zero-worker-constraint'
  | 'no-route'
  | 'tool-unauthorized'
  | 'admission-rejected'
  | 'level-verification-stopped'
  | 'cancelled-before-start'
  | 'cancelled-after-start'
  | 'start-failed'
  | 'blocked-result'
  | 'failed-result'
  | 'handoff-payload-too-large'
  | 'completed'
  | 'violation'

export interface ParallelNodeResultV1 {
  readonly schemaVersion: 1
  readonly nodeId: string
  readonly requestId: string
  readonly workerRef?: string
  readonly status: 'completed' | 'blocked' | 'failed' | 'ownership-violation' | 'not-run'
  readonly reason: NodeOutcomeReasonV1
}

export interface OwnershipViolationSummaryV1 {
  readonly nodeId: string
  readonly count: number
  readonly digest: string
  readonly samplePaths: readonly string[]
}

export interface ParallelAggregateV1 {
  readonly schemaVersion: 1
  readonly dagId: string
  readonly scope: 'level' | 'dag'
  readonly fanoutId: string
  readonly levelId?: string
  readonly levelIndex?: number
  readonly nodeResults: readonly ParallelNodeResultV1[]
  readonly aggregateStatus: 'completed' | 'blocked' | 'failed' | 'verification-failed'
  readonly verificationOutcome: VerificationOutcomeV1
  readonly verification?: readonly VerificationEvidenceV1[]
  readonly ownershipViolations: readonly OwnershipViolationSummaryV1[]
  readonly projectedHandoff: HandoffV1
  readonly projectedHandoffTruncated?: true
}

export interface CapabilityRequestV1 {
  readonly schemaVersion: 1
  readonly target: SchedulingTargetV1
  readonly taskId: string
  readonly objective: string
  readonly profile: CapabilityProfileV1
  readonly constraints: SchedulingConstraintsV1
  readonly workspaceFingerprint?: string
  readonly repoRevision?: string
  readonly affinity?: {
    readonly workerId?: string
    readonly modelFamily?: string
    readonly snapshotId?: string
  }
  readonly priorHandoff?: HandoffV1
}

export interface RouteDecisionV1 {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly reasoningEffort?: string
  readonly promptProfile?: string
  readonly modelFamily?: string
}

export interface ScheduleDecisionV1 {
  readonly schemaVersion: 1
  readonly mode: 'direct' | 'single-worker'
  readonly route: RouteDecisionV1
  readonly workerCount: 0 | 1
  readonly source: 'scheduler' | 'profile-fallback'
  readonly policyVersion: string
  readonly affinityKey?: string
  readonly explanationCode?: string
}

export interface BudgetViewV1 {
  readonly maxWorkers: number
  readonly admittedWorkers: number
  readonly maxPluginToolActions: number
  readonly admittedPluginToolActions: number
  readonly remainingWorkers: number
  readonly remainingPluginToolActions: number
}

export interface ScheduleFeedbackV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly outcome: 'completed' | 'blocked' | 'failed' | 'budget-rejected' | 'verification-failed'
  readonly handoff?: HandoffV1
  readonly verification?: readonly VerificationEvidenceV1[]
  readonly budgetRejection?: {
    readonly code: 'WORKER_LIMIT' | 'PLUGIN_TOOL_LIMIT' | 'DISPOSED'
    readonly limit: number
    readonly observed: number
  }
  readonly actual?: {
    readonly provider?: string
    readonly model?: string
    readonly durationMs?: number
    readonly toolCalls?: number
  }
}

export interface ScheduleSelectedV1 {
  readonly schemaVersion: 1
  readonly target: 'root' | 'worker'
  readonly source: 'scheduler' | 'profile-fallback'
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly reasoningEffort?: string
  readonly promptProfile?: string
  readonly modelFamily?: string
  readonly policyVersion?: string
  /** Present together only for a correlated parallel worker selection. */
  readonly fanoutId?: string
  readonly nodeId?: string
  readonly requestId?: string
}

export interface AdaptiveSchedulerService {
  schedule(request: CapabilityRequestV1, budget: BudgetViewV1, signal: AbortSignal): Promise<ScheduleDecisionV1>
  hydrate?(request: CapabilityRequestV1, decision: ScheduleDecisionV1, selectedAt: number): void
  observe?(feedback: ScheduleFeedbackV1): void
  complete?(requestId: string): void
  disposeSession?(requestId: string): void
  dispose?(): Promise<void>
}
