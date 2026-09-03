import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCourtlistenerCaseOpinions } from "../lib/courtlistener";
import { sendInternalError } from "../lib/httpError";
import { guardedFetch, loadConnector } from "../lib/mcp/client";
import {
  cacheExternalSourceDocument,
  loadCachedExternalSourceDocument,
} from "../lib/mcp/sourceDocumentCache";
import {
  getMcpOAuthBearerToken,
  McpOAuthRequiredError,
} from "../lib/mcp/oauth";
import {
  LEGAL_DATA_HUNTER_MCP_URL,
  legalDataHunterDocumentId,
  normalizeLegalDataHunterDocument,
  parseLegalDataHunterDocumentId,
  type LegalDataHunterDocumentLocator,
} from "../lib/mcp/sourceDocuments";
import { createServerSupabase } from "../lib/supabase";
import { caseClusterId, normalizeCaseDocument } from "../lib/sourceDocuments";
import { getUserModelSettings } from "../lib/userSettings";

export const sourceDocumentsRouter = Router();

sourceDocumentsRouter.use(requireAuth);

const documentFetches = new Map<string, Promise<unknown>>();
const MAX_LEGAL_DATA_HUNTER_RESPONSE_BYTES = 1_000_000;

class SourceDocumentNotFoundError extends Error {}

class SourceDocumentRateLimitError extends Error {
  constructor(readonly retryAfter: string | null) {
    super("Legal Data Hunter is temporarily rate limited.");
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_LEGAL_DATA_HUNTER_RESPONSE_BYTES
  ) {
    throw new Error("Legal Data Hunter returned an oversized document.");
  }
  if (!response.body) {
    throw new Error("Legal Data Hunter returned an empty document.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_LEGAL_DATA_HUNTER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Legal Data Hunter returned an oversized document.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function fetchLegalDataHunterDocument(
  userId: string,
  locator: LegalDataHunterDocumentLocator,
) {
  const db = createServerSupabase();
  const documentId = legalDataHunterDocumentId(locator);
  let connector;
  try {
    connector = await loadConnector(userId, locator.connectorId, db);
  } catch {
    throw new SourceDocumentNotFoundError();
  }
  let canonicalConnector = false;
  try {
    canonicalConnector =
      new URL(connector.server_url).href === LEGAL_DATA_HUNTER_MCP_URL;
  } catch {
    canonicalConnector = false;
  }
  if (
    !connector.enabled ||
    connector.auth_type !== "oauth" ||
    !canonicalConnector
  ) {
    throw new SourceDocumentNotFoundError();
  }

  const cached = await loadCachedExternalSourceDocument(db, userId, documentId);
  if (cached) return cached;

  const accessToken = await getMcpOAuthBearerToken(connector, db);
  const [country, sourceName] = locator.source.split("/");
  const url =
    `${LEGAL_DATA_HUNTER_MCP_URL.replace(/\/mcp$/, "")}` +
    `/v1/documents/${encodeURIComponent(country)}/${encodeURIComponent(sourceName)}` +
    `?source_id=${encodeURIComponent(locator.sourceId)}`;
  const response = await guardedFetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (response.status === 404) throw new SourceDocumentNotFoundError();
  if (response.status === 401 || response.status === 403) {
    throw new McpOAuthRequiredError(
      "Legal Data Hunter authorization expired. Please reconnect.",
    );
  }
  if (response.status === 429) {
    throw new SourceDocumentRateLimitError(response.headers.get("retry-after"));
  }
  if (!response.ok) {
    throw new Error(
      `Legal Data Hunter document request failed (${response.status}).`,
    );
  }

  const value = await readLimitedJson(response);
  const document = normalizeLegalDataHunterDocument(value, locator);
  if (!document) {
    throw new Error("Legal Data Hunter returned an invalid document.");
  }
  await cacheExternalSourceDocument(db, userId, document);
  return document;
}

// Hydrate opaque source-document IDs that need provider-backed content. File
// documents use the existing single-document viewer endpoints; CourtListener
// and Legal Data Hunter both resolve through this normalized contract.
sourceDocumentsRouter.get("/:documentId", async (req, res) => {
  const documentId = String(req.params.documentId ?? "");
  const legalDataHunterLocator = parseLegalDataHunterDocumentId(documentId);
  const clusterId = caseClusterId(documentId);
  if (!legalDataHunterLocator && !clusterId) {
    return res.status(404).json({ detail: "Document not found" });
  }

  try {
    const userId = String(res.locals.userId ?? "");
    const fetchKey = `${userId}:${documentId}`;
    let request = documentFetches.get(fetchKey);

    if (legalDataHunterLocator) {
      if (!request) {
        request = fetchLegalDataHunterDocument(
          userId,
          legalDataHunterLocator,
        ).finally(() => documentFetches.delete(fetchKey));
        documentFetches.set(fetchKey, request);
      }
      return res.json(await request);
    }

    const settings = await getUserModelSettings(userId);
    if (!request) {
      request = getCourtlistenerCaseOpinions({
        clusterId: clusterId!,
        db: createServerSupabase(),
        includeFullText: true,
        maxChars: 50000,
        apiToken: settings.api_keys.courtlistener,
      }).finally(() => documentFetches.delete(fetchKey));
      documentFetches.set(fetchKey, request);
    }

    const fetched = await request;
    const value =
      fetched && typeof fetched === "object" && !Array.isArray(fetched)
        ? (fetched as Record<string, unknown>)
        : {};
    return res.json(
      normalizeCaseDocument({
        clusterId: clusterId!,
        caseName:
          typeof value.caseName === "string" ? value.caseName : undefined,
        citations: Array.isArray(value.citations)
          ? value.citations.filter(
              (citation): citation is string => typeof citation === "string",
            )
          : undefined,
        dateFiled:
          typeof value.dateFiled === "string" ? value.dateFiled : undefined,
        url: typeof value.url === "string" ? value.url : undefined,
        pdfUrl: typeof value.pdfUrl === "string" ? value.pdfUrl : undefined,
        opinions: Array.isArray(value.opinions) ? value.opinions : [],
      }),
    );
  } catch (error) {
    if (error instanceof SourceDocumentNotFoundError) {
      return res.status(404).json({ detail: "Document not found" });
    }
    if (error instanceof SourceDocumentRateLimitError) {
      if (error.retryAfter) res.setHeader("Retry-After", error.retryAfter);
      return res.status(429).json({
        detail:
          "This source is temporarily rate limited. Please try again shortly.",
      });
    }
    if (error instanceof McpOAuthRequiredError) {
      return res.status(409).json({
        detail: "Legal Data Hunter needs to be reconnected in Settings.",
      });
    }
    return sendInternalError(res, error, 502);
  }
});
