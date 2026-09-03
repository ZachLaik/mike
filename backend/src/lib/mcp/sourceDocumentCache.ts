import type { SourceDocument } from "../sourceDocuments";
import type { Db } from "./types";

const CACHE_TABLE = "user_external_source_documents";
const CASE_TTL_MS = 24 * 60 * 60 * 1_000;
const LEGISLATION_TTL_MS = 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCachedDocument(
  value: unknown,
  documentId: string,
): value is SourceDocument {
  return (
    isRecord(value) &&
    value.document_id === documentId &&
    typeof value.title === "string" &&
    (value.type === "case" || value.type === "legislation") &&
    Array.isArray(value.metadata) &&
    Array.isArray(value.quotes) &&
    Array.isArray(value.subdocuments) &&
    value.subdocuments.length > 0
  );
}

export async function loadCachedExternalSourceDocument(
  db: Db,
  userId: string,
  documentId: string,
): Promise<SourceDocument | null> {
  const { data, error } = await db
    .from(CACHE_TABLE)
    .select("document")
    .eq("user_id", userId)
    .eq("document_id", documentId)
    .eq("provider", "legal-data-hunter")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  const document = isRecord(data) ? data.document : null;
  return isCachedDocument(document, documentId) ? document : null;
}

export async function cacheExternalSourceDocument(
  db: Db,
  userId: string,
  document: SourceDocument,
): Promise<void> {
  const ttl = document.type === "case" ? CASE_TTL_MS : LEGISLATION_TTL_MS;
  const now = new Date();
  const { error } = await db.from(CACHE_TABLE).upsert(
    {
      user_id: userId,
      document_id: document.document_id,
      provider: "legal-data-hunter",
      document,
      expires_at: new Date(now.valueOf() + ttl).toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "user_id,document_id" },
  );
  if (error) throw error;
}
