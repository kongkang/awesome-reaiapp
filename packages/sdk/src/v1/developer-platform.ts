/** `developer.platform@1` —— 开放平台系统插件专用的最小管理合同。 */

export const DEVELOPER_CENTER_APP_ID = "com.reai.developer-center" as const;
export const DEVELOPER_PLATFORM_CAPABILITY = "developer.platform@1" as const;

/** 这些是 `developer.platform@1` 在 Host API 1.15.0 中唯一允许的 Bridge 方法。 */
export const DeveloperPlatformRequestMethod = {
  ContextGet: "developer.platform.context.get",
  ProjectsList: "developer.platform.projects.list",
  ScopesList: "developer.platform.scopes.list",
  ProductsList: "developer.platform.products.list",
  ProductsCreate: "developer.platform.products.create",
  ClientsGet: "developer.platform.clients.get",
} as const;

export const DEVELOPER_PLATFORM_REQUEST_METHODS = [
  DeveloperPlatformRequestMethod.ContextGet,
  DeveloperPlatformRequestMethod.ProjectsList,
  DeveloperPlatformRequestMethod.ScopesList,
  DeveloperPlatformRequestMethod.ProductsList,
  DeveloperPlatformRequestMethod.ProductsCreate,
  DeveloperPlatformRequestMethod.ClientsGet,
] as const;

export type DeveloperPlatformRequestMethod =
  (typeof DEVELOPER_PLATFORM_REQUEST_METHODS)[number];

export const DEVELOPER_PLATFORM_BACKEND_ERROR_CODES = [
  "BACKEND_CAPABILITY_UNAVAILABLE",
  "DEVELOPER_PLATFORM_NOT_LOGGED_IN",
  "DEVELOPER_PLATFORM_REAUTH_REQUIRED",
  "DEVELOPER_PLATFORM_UNAUTHORIZED_CLIENT",
  "DEVELOPER_PLATFORM_INVALID_REQUEST",
  "DEVELOPER_PLATFORM_NOT_FOUND",
  "DEVELOPER_PLATFORM_CONFLICT",
  "DEVELOPER_PLATFORM_RATE_LIMITED",
  "DEVELOPER_PLATFORM_BACKEND_REJECTED",
] as const;

export type DeveloperPlatformBackendErrorCode =
  (typeof DEVELOPER_PLATFORM_BACKEND_ERROR_CODES)[number];

export interface DeveloperPlatformContext {
  account: {
    enabled: boolean;
    loggedIn: boolean;
  };
  backend: {
    available: boolean;
    errorCode: DeveloperPlatformBackendErrorCode | null;
  };
  /** #1216 可用后由 Host 从管理后端返回；F3A 产品 Host 不伪造团队。 */
  teams?: DeveloperTeamSummary[];
}

export interface DeveloperTeamSummary {
  id: string;
  name: string;
  slug?: string | null;
}

export interface DeveloperProjectSummary {
  id: string;
  teamId: string;
  name: string;
  description?: string | null;
  systemPurpose?: string | null;
}

export interface DeveloperScopeSummary {
  code: string;
  name: string;
  description: string | null;
  selfServiceEligibility?: {
    development: string;
    public: string;
  };
  definitionVersion: number;
}

export interface DeveloperProductClientSummary {
  /** 管理记录 UUID；调用 clients.get 使用它，不是公开 OAuth Client ID。 */
  id: string;
  productId: string;
  clientId: string;
  clientLabel: string | null;
  name: string;
  projectId: string;
  appType: string;
  currentPublicRevisionId: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperReviewSubmissionSummary {
  id: string;
  appId: string;
  productId: string;
  revisionId: string;
  status: string;
  startedAt: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperProductReleaseSummary {
  id: string;
  productId: string;
  appId: string;
  submissionId: string;
  version: string;
  status: string;
  approvedAt: string | null;
  publishedAt: string | null;
  delistedAt: string | null;
  supersededByReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperProductSummary {
  id: string;
  /** Product 的主 OAuth App 管理记录 UUID，不是公开 OAuth `client_id`。 */
  primaryManagementClientId: string;
  ownerUserId: string;
  teamId: string;
  projectId: string;
  listingKind: "plugin";
  packageAppId: string | null;
  firstApprovedAt: string | null;
  clients: DeveloperProductClientSummary[];
  submissions: DeveloperReviewSubmissionSummary[];
  releases: DeveloperProductReleaseSummary[];
}

export interface DeveloperClientRevisionSummary {
  id: string;
  revisionNumber: number;
  name: string;
  description: string | null;
  scopes: string[];
  redirectUris: string[];
  isDraft: boolean;
  isFrozen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperClientDetail {
  client: DeveloperProductClientSummary;
  revisions: DeveloperClientRevisionSummary[];
}

export interface DeveloperProjectsListInput {
  teamId: string;
}

export interface DeveloperScopesListInput {
  teamId: string;
  projectId: string;
  context: "development";
}

export interface DeveloperProductsListInput {
  teamId: string;
}

export interface DeveloperProductCreateInput {
  teamId: string;
  projectId: string;
  name: string;
  purpose: string;
  scopeCodes: string[];
  idempotencyKey: string;
}

export interface DeveloperProductCreateResult {
  productId: string;
  /** 后端管理记录 UUID；不能作为 OAuth client_id 展示或授权。 */
  managementClientId: string;
  /** 插件 manifest/oauthAppId 使用的公开 OAuth Client ID。 */
  oauthClientId: string;
  draftRevisionId: string;
  idempotent: boolean;
}

export interface DeveloperClientGetInput {
  teamId: string;
  /** 后端管理记录 UUID；与返回值中的公开 `client.clientId` 不同。 */
  managementClientId: string;
}

export interface DeveloperPlatformClient {
  getContext(): Promise<DeveloperPlatformContext>;
  listProjects(input: DeveloperProjectsListInput): Promise<DeveloperProjectSummary[]>;
  listScopes(input: DeveloperScopesListInput): Promise<DeveloperScopeSummary[]>;
  listProducts(input: DeveloperProductsListInput): Promise<DeveloperProductSummary[]>;
  createProduct(input: DeveloperProductCreateInput): Promise<DeveloperProductCreateResult>;
  getClient(input: DeveloperClientGetInput): Promise<DeveloperClientDetail>;
}

export type DeveloperPlatformRequest =
  | { method: typeof DeveloperPlatformRequestMethod.ContextGet; params: Record<string, never> }
  | { method: typeof DeveloperPlatformRequestMethod.ProjectsList; params: DeveloperProjectsListInput }
  | { method: typeof DeveloperPlatformRequestMethod.ScopesList; params: DeveloperScopesListInput }
  | { method: typeof DeveloperPlatformRequestMethod.ProductsList; params: DeveloperProductsListInput }
  | { method: typeof DeveloperPlatformRequestMethod.ProductsCreate; params: DeveloperProductCreateInput }
  | { method: typeof DeveloperPlatformRequestMethod.ClientsGet; params: DeveloperClientGetInput };
