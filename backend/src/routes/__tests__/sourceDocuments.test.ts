import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getCourtlistenerCaseOpinions,
  getUserModelSettings,
  loadConnector,
  getMcpOAuthBearerToken,
  guardedFetch,
  loadCachedExternalSourceDocument,
  cacheExternalSourceDocument,
} = vi.hoisted(() => ({
  getCourtlistenerCaseOpinions: vi.fn(),
  getUserModelSettings: vi.fn(),
  loadConnector: vi.fn(),
  getMcpOAuthBearerToken: vi.fn(),
  guardedFetch: vi.fn(),
  loadCachedExternalSourceDocument: vi.fn(),
  cacheExternalSourceDocument: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    next();
  },
}));
vi.mock("../../lib/courtlistener", () => ({
  getCourtlistenerCaseOpinions: (...args: unknown[]) =>
    getCourtlistenerCaseOpinions(...args),
}));
vi.mock("../../lib/userSettings", () => ({
  getUserModelSettings: (...args: unknown[]) => getUserModelSettings(...args),
}));
vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({ name: "test-db" })),
}));
vi.mock("../../lib/mcp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mcp/client")>()),
  loadConnector: (...args: unknown[]) => loadConnector(...args),
  guardedFetch: (...args: unknown[]) => guardedFetch(...args),
}));
vi.mock("../../lib/mcp/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mcp/oauth")>()),
  getMcpOAuthBearerToken: (...args: unknown[]) =>
    getMcpOAuthBearerToken(...args),
}));
vi.mock("../../lib/mcp/sourceDocumentCache", () => ({
  loadCachedExternalSourceDocument: (...args: unknown[]) =>
    loadCachedExternalSourceDocument(...args),
  cacheExternalSourceDocument: (...args: unknown[]) =>
    cacheExternalSourceDocument(...args),
}));

import { legalDataHunterDocumentId } from "../../lib/mcp/sourceDocuments";
import { sourceDocumentsRouter } from "../sourceDocuments";

const app = express();
app.use("/documents", sourceDocumentsRouter);

const documentId = legalDataHunterDocumentId({
  connectorId: "connector-1",
  source: "FR/CASS",
  sourceId: "JURITEXT000006994248",
});

const connector = {
  id: "connector-1",
  user_id: "user-1",
  name: "Legal Data Hunter",
  transport: "streamable_http",
  server_url: "https://legaldatahunter.com/mcp",
  auth_type: "oauth",
  enabled: true,
  tool_policy: {},
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-09-03T00:00:00.000Z",
  updated_at: "2026-09-03T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  loadConnector.mockResolvedValue(connector);
  getMcpOAuthBearerToken.mockResolvedValue("oauth-token");
  loadCachedExternalSourceDocument.mockResolvedValue(null);
  cacheExternalSourceDocument.mockResolvedValue(undefined);
  guardedFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        source: "FR/CASS",
        source_id: "JURITEXT000006994248",
        data_type: "case_law",
        title: "Cour de cassation, 27 octobre 1975",
        text: "Full canonical judgment text.",
        url: "https://www.legifrance.gouv.fr/juri/id/JURITEXT000006994248",
        country: "FR",
        court: "Cour de cassation",
        date: "1975-10-27",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

describe("GET /documents/:documentId for Legal Data Hunter", () => {
  it("hydrates a registered LDH handle with the user's OAuth token", async () => {
    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(200);
    expect(loadCachedExternalSourceDocument).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      documentId,
    );
    expect(loadConnector).toHaveBeenCalledWith(
      "user-1",
      "connector-1",
      expect.anything(),
    );
    expect(getMcpOAuthBearerToken).toHaveBeenCalledWith(
      connector,
      expect.anything(),
    );
    expect(guardedFetch).toHaveBeenCalledWith(
      "https://legaldatahunter.com/v1/documents/FR/CASS?source_id=JURITEXT000006994248",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer oauth-token",
        },
      },
    );
    expect(response.body).toMatchObject({
      document_id: documentId,
      type: "case",
      title: "Cour de cassation, 27 octobre 1975",
      subdocuments: [{ text: "Full canonical judgment text." }],
    });
    expect(cacheExternalSourceDocument).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ document_id: documentId }),
    );
  });

  it("returns a persisted hydrated document without another LDH request", async () => {
    loadCachedExternalSourceDocument.mockResolvedValueOnce({
      document_id: documentId,
      title: "Persisted case",
      type: "case",
      metadata: [],
      quotes: [],
      subdocuments: [
        {
          document_id: `${documentId}:text`,
          title: "Persisted case",
          type: "html",
          text: "Persisted canonical text.",
        },
      ],
    });

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.title).toBe("Persisted case");
    expect(loadConnector).toHaveBeenCalledWith(
      "user-1",
      "connector-1",
      expect.anything(),
    );
    expect(getMcpOAuthBearerToken).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(cacheExternalSourceDocument).not.toHaveBeenCalled();
  });

  it("does not serve a cached document after the connector is disabled", async () => {
    loadConnector.mockResolvedValueOnce({ ...connector, enabled: false });

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(404);
    expect(loadCachedExternalSourceDocument).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("does not fetch through a connector the user does not own", async () => {
    loadConnector.mockRejectedValueOnce(new Error("not found"));

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(404);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized LDH response before reading or caching it", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "1000001",
        },
      }),
    );

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(502);
    expect(cacheExternalSourceDocument).not.toHaveBeenCalled();
  });

  it("fails closed when LDH returns a different source identity", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source: "FR/CASS",
          source_id: "DIFFERENT-ID",
          data_type: "case_law",
          title: "Wrong document",
          text: "Wrong text",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(502);
  });

  it("forwards an HTTP-date Retry-After without describing it as seconds", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    );

    const response = await request(app).get(
      `/documents/${encodeURIComponent(documentId)}`,
    );

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe(
      "Wed, 21 Oct 2026 07:28:00 GMT",
    );
    expect(response.body.detail).toBe(
      "This source is temporarily rate limited. Please try again shortly.",
    );
  });
});
