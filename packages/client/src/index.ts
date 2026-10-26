import {
  type AssetRecord,
  type AttachSubjectReferenceInput,
  type ChangeRecord,
  type CompositionRevisionRecord,
  type CompositionSummary,
  computeSha256Hex,
  DomainError,
  type DomainErrorCode,
  type ProjectRecord,
  type ProjectOverview,
  type ProposalRecord,
  type SubjectPatchChanges,
  type SubjectRecord,
  type TypedOperation,
} from "@vflow/domain";
import type {
  WorkflowContext,
  CompositionDocument,
  PortableCompositionBundle,
  ProjectRole,
  ProtocolVersion,
  ReferencePackEntry,
  RevisionStatus,
  SubjectKind,
  SubjectSnapshot,
  SubjectVariant,
} from "@vflow/protocol";

export interface VFlowClientOptions {
  baseUrl?: string;
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class VFlowClient {
  private readonly baseUrl: string;
  private readonly fetchFn: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly workflowContexts = new Map<string, WorkflowContext>();
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: VFlowClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost").replace(/\/$/, "");
    const rawFetch =
      options.fetchFn ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    this.fetchFn = (input: RequestInfo | URL, init?: RequestInit) =>
      rawFetch(input, init);
    this.defaultHeaders = options.headers ?? {};
  }

  withHeaders(headers: Record<string, string>): VFlowClient {
    return new VFlowClient({
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      headers: { ...this.defaultHeaders, ...headers },
    });
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const projectMatch = /^\/v1\/projects\/([^/]+)\//.exec(path);
    const context =
      projectMatch &&
      this.workflowContexts.get(decodeURIComponent(projectMatch[1]));
    if (
      context &&
      typeof init.body === "string" &&
      ["POST", "PATCH", "PUT"].includes(init.method ?? "")
    ) {
      const body = JSON.parse(init.body);
      init = {
        ...init,
        body: JSON.stringify({ workflowContext: context, ...body }),
      };
    }
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...this.defaultHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const payload = (await res
      .json()
      .catch(() => ({
        error: {
          code: res.status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
          message: `HTTP ${res.status}`,
        },
      }))) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (payload.error ?? {}) as Record<string, unknown>;
      const code = (errObj.code ?? "INTERNAL_ERROR") as DomainErrorCode;
      const message = String(errObj.message ?? `HTTP ${res.status}`);
      throw new DomainError(code, message, errObj);
    }
    return payload as T;
  }

  async callMcpTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.defaultHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `mcp-${Date.now()}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      }),
    });
    const rpc = (await res.json()) as {
      result?: {
        structuredContent?: T;
        content?: Array<{ type: string; text?: string }>;
      };
      error?: {
        code: number;
        message: string;
        data?: Record<string, unknown>;
      };
    };
    if (rpc.error) {
      const domainCode = (rpc.error.data?.code ??
        (rpc.error.code === -32001
          ? "UNAUTHORIZED"
          : "INTERNAL_ERROR")) as DomainErrorCode;
      throw new DomainError(domainCode, rpc.error.message, rpc.error.data);
    }
    if (rpc.result?.structuredContent !== undefined) {
      return rpc.result.structuredContent;
    }
    const text = rpc.result?.content?.find(
      (item) => item.type === "text",
    )?.text;
    if (text !== undefined) return JSON.parse(text) as T;
    throw new DomainError(
      "INTERNAL_ERROR",
      "MCP result contains no readable content.",
    );
  }

  async getSession() {
    return this.requestJson<{
      actor: import("@vflow/protocol").ActorIdentity;
      logoutUrl: string;
    }>("/v1/session");
  }
  async listTrash() {
    return this.requestJson<{
      items: import("@vflow/domain").TrashItem[];
    }>("/v1/trash");
  }
  async changeResource(input: {
    projectId: string;
    kind: "project" | "composition";
    id: string;
    action: "trash" | "restore";
    baseRevision: number;
    operationId: string;
    expectedHeadRevision?: number;
  }) {
    const base = `/v1/projects/${encodeURIComponent(input.projectId)}`;
    const path =
      input.kind === "project"
        ? base + (input.action === "restore" ? "/restore" : "")
        : `${base}/compositions/${encodeURIComponent(input.id)}` +
          (input.action === "restore" ? "/restore-from-trash" : "");
    return this.requestJson<{
      revision: number;
      event: import("@vflow/domain").LifecycleEvent;
    }>(path, {
      method: input.action === "trash" ? "DELETE" : "POST",
      body: JSON.stringify(input),
    });
  }
  async setProjectMember(input: {
    projectId: string;
    targetActorId: string;
    role: ProjectRole | null;
    baseRevision: number;
    operationId: string;
  }) {
    const result = await this.requestJson<{ project: ProjectRecord }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/members/${encodeURIComponent(input.targetActorId)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return result.project;
  }

  async getAuthoringWorkflow(projectId: string) {
    const workflow = await this.requestJson<
      Awaited<
        ReturnType<
          import("@vflow/domain").ReferenceAuthoringService["workflow"]
        >
      >
    >(`/v1/projects/${encodeURIComponent(projectId)}/authoring/workflow`);
    this.workflowContexts.set(projectId, workflow.workflowContext);
    return workflow;
  }
  async getAuthoringImpact(projectId: string, id: string, revision: number) {
    return this.requestJson<
      Awaited<
        ReturnType<
          import("@vflow/domain").ReferenceAuthoringService["impact"]
        >
      >
    >(
      `/v1/projects/${encodeURIComponent(projectId)}/authoring/impact/${encodeURIComponent(id)}/${revision}`,
    );
  }
  async listAuthoringDocuments(projectId: string) {
    return this.requestJson<import("@vflow/protocol").MaterialRecord[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/authoring/documents`,
    );
  }
  async getAuthoringDocument(projectId: string, id: string, revision?: number) {
    return this.requestJson<import("@vflow/protocol").MaterialRevision>(
      `/v1/projects/${encodeURIComponent(projectId)}/authoring/documents/${encodeURIComponent(id)}${revision === undefined ? "" : `?revision=${revision}`}`,
    );
  }
  async putAuthoringDocument(
    input: Parameters<
      import("@vflow/domain").ReferenceAuthoringService["put"]
    >[1],
  ) {
    return this.requestJson<import("@vflow/protocol").MaterialRevision>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/authoring/documents`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async reviewAuthoringDocument(
    input: Parameters<
      import("@vflow/domain").ReferenceAuthoringService["review"]
    >[1],
  ) {
    return this.requestJson<import("@vflow/protocol").MaterialRevision>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/authoring/documents/${encodeURIComponent(input.id)}/review`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async approveAuthoringDocument(
    input: Parameters<
      import("@vflow/domain").ReferenceAuthoringService["approve"]
    >[1],
  ) {
    return this.requestJson<import("@vflow/protocol").MaterialRevision>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/authoring/documents/${encodeURIComponent(input.id)}/approve`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async validateAuthoringDocument(projectId: string, document: unknown) {
    return this.requestJson<
      import("@vflow/protocol").AuthoringValidation
    >(`/v1/projects/${encodeURIComponent(projectId)}/authoring/validate`, {
      method: "POST",
      body: JSON.stringify({ document }),
    });
  }
  async prepareGenerationInputs(projectId: string, request: unknown) {
    return this.requestJson<{
      ready: boolean;
      diagnostics: import("@vflow/protocol").AuthoringDiagnostic[];
      packet?: import("@vflow/protocol").GenerationInputPacket;
    }>(`/v1/projects/${encodeURIComponent(projectId)}/authoring/prepare`, {
      method: "POST",
      body: JSON.stringify({ request }),
    });
  }
  async recordGenerationEvidence(
    input: Parameters<
      import("@vflow/domain").ReferenceAuthoringService["recordEvidence"]
    >[1],
  ) {
    return this.requestJson<
      import("@vflow/protocol").GenerationEvidence
    >(
      `/v1/projects/${encodeURIComponent(input.projectId)}/authoring/evidence`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async listGenerationEvidence(projectId: string) {
    return this.requestJson<
      import("@vflow/protocol").GenerationEvidence[]
    >(`/v1/projects/${encodeURIComponent(projectId)}/authoring/evidence`);
  }

  async createProject(input: {
    id: string;
    name: string;
    description?: string;
    members?: Record<string, ProjectRole>;
    operationId?: string;
    authoringMode?: "strict" | "legacy";
    sharingMode?: "private" | "members";
  }): Promise<ProjectRecord> {
    const data = await this.requestJson<{ project: ProjectRecord }>(
      "/v1/projects",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.project;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const data = await this.requestJson<{ projects: ProjectRecord[] }>(
      "/v1/projects",
    );
    return data.projects;
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    const data = await this.requestJson<{ project: ProjectRecord }>(
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
    return data.project;
  }

  async getProjectOverview(projectId: string): Promise<ProjectOverview> {
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(projectId)}/overview`,
    );
  }

  async listCompositions(projectId: string): Promise<CompositionSummary[]> {
    const data = await this.requestJson<{ compositions: CompositionSummary[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/compositions`,
    );
    return data.compositions;
  }

  async getProjectAccess(projectId: string): Promise<{ role: ProjectRole }> {
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(projectId)}/access`,
    );
  }

  async uploadAsset(input: {
    projectId: string;
    assetId: string;
    bytes: Uint8Array;
    expectedSha256?: string;
    mimeType: string;
    width?: number;
    height?: number;
    durationFrames?: number;
  }): Promise<AssetRecord> {
    const sha256 =
      input.expectedSha256 ?? (await computeSha256Hex(input.bytes));
    const prep = await this.requestJson<{
      session: { sessionId: string };
    }>(`/v1/projects/${encodeURIComponent(input.projectId)}/assets/prepare`, {
      method: "POST",
      body: JSON.stringify({
        assetId: input.assetId,
        sha256,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        width: input.width,
        height: input.height,
        durationFrames: input.durationFrames,
      }),
    });

    await this.requestJson(
      `/v1/projects/${encodeURIComponent(input.projectId)}/assets/upload/${encodeURIComponent(prep.session.sessionId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          contentBase64: encodeBase64Bytes(input.bytes),
        }),
      },
    );

    const finalized = await this.requestJson<{ asset: AssetRecord }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/assets/finalize`,
      {
        method: "POST",
        body: JSON.stringify({ sessionId: prep.session.sessionId }),
      },
    );
    return finalized.asset;
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    const data = await this.requestJson<{ assets: AssetRecord[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/assets`,
    );
    return data.assets;
  }

  assetContentUrl(projectId: string, assetId: string): string {
    return `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content`;
  }

  async deleteAsset(
    projectId: string,
    assetId: string,
  ): Promise<{ deletedAssetId: string }> {
    return this.requestJson<{ deletedAssetId: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      { method: "DELETE" },
    );
  }

  async createSubject(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    id: string;
    kind: SubjectKind;
    name: string;
    defaultVariant?: string;
    status?: RevisionStatus;
    definition: { description: string; invariants: string[] };
    variants: Record<string, SubjectVariant>;
  }): Promise<SubjectRecord> {
    const data = await this.requestJson<{ subject: SubjectRecord }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/subjects`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.subject;
  }

  async patchSubject(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    subjectId: string;
    baseRevision: number;
    operationId: string;
    changes: SubjectPatchChanges;
  }): Promise<SubjectSnapshot> {
    const data = await this.requestJson<{ snapshot: SubjectSnapshot }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/subjects/${encodeURIComponent(input.subjectId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
    return data.snapshot;
  }

  async attachSubjectReference(
    input: AttachSubjectReferenceInput,
  ): Promise<SubjectSnapshot> {
    const data = await this.requestJson<{ snapshot: SubjectSnapshot }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/subjects/${encodeURIComponent(input.subjectId)}/references`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.snapshot;
  }

  async approveSubjectRevision(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    subjectId: string;
    revision: number;
    operationId: string;
  }): Promise<SubjectSnapshot> {
    const data = await this.requestJson<{ snapshot: SubjectSnapshot }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/subjects/${encodeURIComponent(input.subjectId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.snapshot;
  }

  async getSubject(
    projectId: string,
    subjectId: string,
    revision?: number,
  ): Promise<{ subject: SubjectRecord; snapshot: SubjectSnapshot }> {
    const q = revision !== undefined ? `?revision=${revision}` : "";
    return this.requestJson<{
      subject: SubjectRecord;
      snapshot: SubjectSnapshot;
    }>(
      `/v1/projects/${encodeURIComponent(projectId)}/subjects/${encodeURIComponent(subjectId)}${q}`,
    );
  }

  async listSubjects(
    projectId: string,
    kind?: SubjectKind,
  ): Promise<SubjectRecord[]> {
    const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    const data = await this.requestJson<{ subjects: SubjectRecord[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/subjects${q}`,
    );
    return data.subjects;
  }

  async createComposition(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    document: CompositionDocument;
    operationId?: string;
  }): Promise<CompositionRevisionRecord> {
    const data = await this.requestJson<{
      revisionRecord: CompositionRevisionRecord;
    }>(`/v1/projects/${encodeURIComponent(input.projectId)}/compositions`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.revisionRecord;
  }

  async getComposition(
    projectId: string,
    compositionId: string,
    revision?: number,
  ): Promise<{
    headRevision: number;
    revisionRecord: CompositionRevisionRecord;
    resolvedSubjects: Record<
      string,
      {
        subjectId: string;
        subjectRevision: number;
        resolvedVariant: string;
        referencePack: ReferencePackEntry[];
        snapshot: SubjectSnapshot;
      }
    >;
  }> {
    const q = revision !== undefined ? `?revision=${revision}` : "";
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compositionId)}${q}`,
    );
  }

  async patchComposition(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    compositionId: string;
    baseRevision: number;
    operationId: string;
    operations: TypedOperation[];
    message?: string;
  }): Promise<{
    revisionRecord: CompositionRevisionRecord;
    changeRecord: ChangeRecord;
  }> {
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(input.projectId)}/compositions/${encodeURIComponent(input.compositionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  }

  async getCompositionHistory(
    projectId: string,
    compositionId: string,
  ): Promise<{
    revisions: CompositionRevisionRecord[];
    changes: ChangeRecord[];
  }> {
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compositionId)}/history`,
    );
  }

  async restoreCompositionRevision(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    compositionId: string;
    targetRevision: number;
    operationId: string;
  }): Promise<CompositionRevisionRecord> {
    const data = await this.requestJson<{
      revisionRecord: CompositionRevisionRecord;
    }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/compositions/${encodeURIComponent(input.compositionId)}/restore`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.revisionRecord;
  }

  async exportCompositionBundle(input: {
    projectId: string;
    compositionId: string;
    revision?: number;
    format: "json" | "yaml";
    targetVersion?: ProtocolVersion;
  }): Promise<{ bundle: PortableCompositionBundle; serialized: string }> {
    const params = new URLSearchParams({ format: input.format });
    if (input.targetVersion) params.set("targetVersion", input.targetVersion);
    if (input.revision !== undefined) {
      params.set("revision", String(input.revision));
    }
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(input.projectId)}/compositions/${encodeURIComponent(input.compositionId)}/export?${params.toString()}`,
    );
  }

  async importCompositionBundle(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    payload: string;
    format: "json" | "yaml";
    targetCompositionId?: string;
    operationId?: string;
    baseRevision?: number;
  }): Promise<CompositionRevisionRecord> {
    const data = await this.requestJson<{
      revisionRecord: CompositionRevisionRecord;
    }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/compositions/import`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.revisionRecord;
  }

  async submitProposal(input: {
    projectId: string;
    compositionId: string;
    baseRevision: number;
    operationId: string;
    description: string;
    operations: TypedOperation[];
  }): Promise<ProposalRecord> {
    const data = await this.requestJson<{ proposal: ProposalRecord }>(
      `/v1/projects/${encodeURIComponent(input.projectId)}/proposals`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return data.proposal;
  }

  async approveProposal(input: {
    projectId: string;
    workflowContext?: WorkflowContext;
    proposalId: string;
    operationId: string;
  }): Promise<{
    proposal: ProposalRecord;
    revisionRecord: CompositionRevisionRecord;
  }> {
    return this.requestJson(
      `/v1/projects/${encodeURIComponent(input.projectId)}/proposals/${encodeURIComponent(input.proposalId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }
}
