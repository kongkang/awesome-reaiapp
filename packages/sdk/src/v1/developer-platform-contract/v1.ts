/** #1411 v1 合同。身份均从官方 Host OAuth token 取得，ID 均为 UUID（public clientId 除外）。 */
export const DEVELOPER_PLATFORM_CONTRACT_VERSION = '1.0' as const
export type DeveloperScope = 'developer:platform' | 'developer:manage' | 'developer:draft' | 'developer:review' | 'developer:release'
export type ActionReason = 'allowed' | 'reauthorization_required' | 'permission_denied' | 'state_conflict' | 'not_supported'
export interface ActionCapability { allowed: boolean; reason: ActionReason; missingScopes: DeveloperScope[] }
export interface Capabilities {
  contractVersion: '1.0'
  productId: string
  managementClientId: string
  actions: Record<'draftRead' | 'draftUpdate' | 'materialsList' | 'materialsUpload' | 'materialsDelete' | 'testersList' | 'testersManage' | 'reviewRead' | 'reviewSubmit' | 'reviewWithdraw' | 'releaseRead' | 'releasePublish' | 'releaseDelist', ActionCapability>
}
export interface Draft {
  id: string; managementClientId: string; name: string; description: string | null
  homepageUrl: string | null; logoUrl: string | null; scopeCodes: string[]
  revisionNumber: number; isDraft: boolean; isFrozen: boolean; updatedAt: string
}
export interface DraftUpdate {
  expectedUpdatedAt: string
  name?: string; description?: string | null; homepageUrl?: string | null; logoUrl?: string | null; scopeCodes?: string[]
}
export interface CatalogMetadata {
  name: string; developerName: string; description: string; tagline: string
  category: 'Agents' | 'Productivity' | 'Media' | 'Writing' | 'Dev'
  iconFileId: string; screenshots: Array<{ fileId: string; caption: string | null }>
}
export interface SubmitReview {
  version: string; catalogMetadata: CatalogMetadata
  artifacts: Array<{ fileId: string; target: 'universal' }>
  confirmPaid: boolean; expectedFeeMilliCredits?: number; expectedPaidQuoteFingerprint?: string
}
export interface Material {
  fileId: string; requestId: string; managementClientId: string; kind: 'package' | 'icon' | 'screenshot'
  version: string; sha256: string; size: number; mimeType: string; status: 'available' | 'unavailable'
  validationStatus: 'validated'; createdAt: string; originalFileName: string
  manifest: { appId: string; publisherId: string; oauthAppId: string; version: string } | null
}
export interface Page<T> { items: T[]; page: number; pageSize: number; hasMore: boolean }
export interface UploadOperation {
  requestId: string; status: 'not_found' | 'in_progress' | 'completed' | 'failed'
  material: Material | null; error: string | null
}
export interface FrozenCatalogMetadata extends Omit<CatalogMetadata, 'iconFileId' | 'screenshots'> {
  iconArtifactId: string; screenshots: Array<{ artifactId: string; caption: string | null }>
}
export interface Review {
  submissionId: string; managementClientId: string; productId: string; revisionId: string
  version: string; status: ReviewStatus; createdAt: string; updatedAt: string
  startedAt: string | null; decisionReason: string | null; decidedAt: string | null
  catalogMetadata: FrozenCatalogMetadata
  artifacts: Array<{ id: string; kind: string; sha256: string; size: number; status: string; displayOrder: number | null; caption: string | null }>
  billing: { fundingType: 'free' | 'paid'; status: BillingStatus; amountMilliCredits: number; refundedAt: string | null } | null
}
export interface ReviewOperation { requestId: string; status: 'not_found' | 'completed'; review: Review | null }
export interface Release {
  releaseId: string; productId: string; managementClientId: string; submissionId: string; revisionId: string
  version: string; status: 'approved' | 'published' | 'delisted' | 'superseded'
  approvedAt: string | null; publishedAt: string | null; delistedAt: string | null; supersededByReleaseId: string | null
}
export interface ReleasePrecheck {
  releaseId: string; revisionId: string; expectedCurrentPublicRevisionId: string | null
  canPublish: true; reason: 'allowed'; securityChanged: boolean
}
export interface ReviewPrecheck {
  managementClientId: string; draftRevisionId: string | null; periodStart: string
  freeLimit: number; freeUsed: number; freeRemaining: number; requiresPaidConfirmation: boolean
  reviewFeeMilliCredits: number; paidQuoteFingerprint: string | null; validationScope: 'quota_and_fee_only'
}
export interface PublishRelease { expectedCurrentPublicRevisionId: string | null }
export interface DelistRelease { expectedCurrentPublicRevisionId: string; reason?: string }
export interface LegacyProduct { productId: string; name: string | null; ownershipState: 'legacy_unassigned'; migrationRequired: true }

export type ReviewStatus = 'queued' | 'pending' | 'in_review' | 'approved' | 'rejected' | 'withdrawn' | 'cancelled'
export type BillingStatus = 'reserved' | 'captured' | 'settled' | 'refunded'
export interface ReviewHistoryQuery { month?: string; page?: number; settlementPage?: number }
export interface ReviewHistoryEntry {
  submissionId: string; productId: string; projectId: string; appName: string | null; version: string
  createdAt: string; reviewStatus: ReviewStatus; fundingType: 'free' | 'paid'; billingStatus: BillingStatus
  amountMilliCredits: number; refundedAt: string | null
}
export interface ReviewHistory {
  periodStart: string; timezone: string; page: number; pageSize: number; total: number
  summary: { freeLimit: number; freeUsed: number; freeRemaining: number; freeReturned: number; paidCount: number
    chargedMilliCredits: number; refundedMilliCredits: number; netMilliCredits: number; reviewFeeMilliCredits: number }
  records: ReviewHistoryEntry[]
  campaign: { state: 'pending' | 'active' | 'ended'; startedAt: string | null; endedAt: string | null; rewardMilli: number }
  settlements: { page: number; pageSize: number; total: number; records: Array<{
    releaseId: string; productId: string; appName: string; version: string; teamId: string; teamName: string
    settledAt: string; refundMilli: number; rewardMilli: number; refundTransactionIds: string[]; rewardTransactionId: string | null
  }> }
}

export interface ReleaseResult { release: Release; currentPublicRevisionId: string | null }
