import type * as Contract from "./developer-platform-contract/v1";
export type { Contract as DeveloperWorkflowContract };
export interface WorkflowClientRef {
  teamId: string;
  managementClientId: string;
}
export interface WorkflowProductRef extends WorkflowClientRef {
  productId: string;
}
export interface WorkflowPage {
  page?: number;
  pageSize?: number;
}
export interface LocalReviewForm {
  version: string;
  name: string;
  developerName: string;
  description: string;
  tagline: string;
  category: Contract.CatalogMetadata["category"];
  iconFileId: string | null;
  packageFileId: string | null;
  screenshots: Array<{ fileId: string; caption: string | null }>;
}
export interface LocalOperation {
  requestId: string;
  action: string;
  fingerprint: string;
  completed: boolean;
  submissionId?: string;
  releaseId?: string;
  expectedCurrentPublicRevisionId?: string | null;
  submission?: Contract.SubmitReview;
  kind?: "package" | "icon" | "screenshot";
  version?: string;
}
export interface PlatformTester {
  userId: string;
  status: "active" | "ineligible";
  displayName: string | null;
  avatarUrl: string | null;
  username: string | null;
}
export interface DeveloperWorkflowRequests {
  materialContent: WorkflowProductRef & { fileId: string };
  reviewArtifactContent: WorkflowProductRef & {
    submissionId: string;
    artifactId: string;
  };
  testersList: WorkflowProductRef;
  testerAdd: WorkflowProductRef & { userId: string; idempotencyKey: string };
  testerRemove: WorkflowProductRef & { testerUserId: string };
  localGet: WorkflowProductRef;
  localSave: WorkflowProductRef & { form: LocalReviewForm };
  materialUpload: WorkflowProductRef & {
    kind: "package" | "icon" | "screenshot";
    version: string;
    idempotencyKey: string;
  };
  capabilities: WorkflowProductRef;
  legacyProducts: WorkflowPage;
  draftGet: WorkflowClientRef;
  draftUpdate: WorkflowClientRef & { draft: Contract.DraftUpdate };
  materialsList: WorkflowProductRef & WorkflowPage;
  uploadStatus: WorkflowProductRef & { requestId: string };
  reviewPrecheck: WorkflowClientRef;
  reviewSubmit: WorkflowProductRef & {
    idempotencyKey: string;
    submission: Contract.SubmitReview;
  };
  reviewsList: WorkflowProductRef & WorkflowPage;
  reviewStatus: WorkflowProductRef & { requestId: string };
  reviewWithdraw: WorkflowProductRef & {
    submissionId: string;
    idempotencyKey: string;
  };
  reviewHistory: { teamId: string } & Contract.ReviewHistoryQuery;
  releasesList: WorkflowProductRef & WorkflowPage & { releaseId?: string };
  publishPrecheck: WorkflowProductRef & { releaseId: string };
  publish: WorkflowProductRef & {
    operationId: string;
    releaseId: string;
    expectedCurrentPublicRevisionId: string | null;
  };
  delist: WorkflowProductRef & {
    operationId: string;
    releaseId: string;
    expectedCurrentPublicRevisionId: string;
    reason?: string;
  };
}
export interface DeveloperWorkflowResults {
  materialContent: {
    success: true;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    base64: string;
  };
  reviewArtifactContent: DeveloperWorkflowResults["materialContent"];
  testersList: {
    success: true;
    testers: {
      owner: PlatformTester;
      items: PlatformTester[];
      testerLimit: number;
      canManageTesters: boolean;
    };
  };
  testerAdd: DeveloperWorkflowResults["testersList"];
  testerRemove: DeveloperWorkflowResults["testersList"];
  localGet: {
    success: true;
    form: LocalReviewForm | null;
    operations: LocalOperation[];
  };
  localSave: DeveloperWorkflowResults["localGet"];
  materialUpload: { success: true; operation: Contract.UploadOperation };
  capabilities: { success: true; capabilities: Contract.Capabilities };
  legacyProducts: {
    success: true;
    products: Contract.Page<Contract.LegacyProduct>;
  };
  draftGet: { success: true; draft: Contract.Draft };
  draftUpdate: DeveloperWorkflowResults["draftGet"];
  materialsList: { success: true; materials: Contract.Page<Contract.Material> };
  uploadStatus: { success: true; operation: Contract.UploadOperation };
  reviewPrecheck: { success: true; precheck: Contract.ReviewPrecheck };
  reviewSubmit: {
    success: true;
    submission: {
      submissionId: string;
      revisionId: string;
      status: Contract.ReviewStatus;
      idempotent: boolean;
    };
  };
  reviewsList: { success: true; reviews: Contract.Page<Contract.Review> };
  reviewStatus: { success: true; operation: Contract.ReviewOperation };
  reviewWithdraw: { success: true; review: Contract.Review };
  reviewHistory: { success: true; history: Contract.ReviewHistory };
  releasesList: {
    success: true;
    releases: Contract.Page<Contract.Release>;
    clients: Array<{
      managementClientId: string;
      currentPublicRevisionId: string | null;
    }>;
  };
  publishPrecheck: { success: true; precheck: Contract.ReleasePrecheck };
  publish: {
    success: true;
    release: Contract.Release;
    currentPublicRevisionId: string;
  };
  delist: {
    success: true;
    release: Contract.Release;
    currentPublicRevisionId: string | null;
  };
}
export type DeveloperWorkflowAction = keyof DeveloperWorkflowRequests;
export type DeveloperWorkflowRequest = {
  [A in DeveloperWorkflowAction]: {
    action: A;
    input: DeveloperWorkflowRequests[A];
  };
}[DeveloperWorkflowAction];
/** Fixed typed operations; never accepts a URL, bearer token or arbitrary HTTP method. */
export interface DeveloperWorkflowClient {
  request<A extends DeveloperWorkflowAction>(
    action: A,
    input: DeveloperWorkflowRequests[A],
  ): Promise<DeveloperWorkflowResults[A]>;
}
