import type {
  SourceDocument,
  SourceDocumentAction,
  SourceDocumentMetadata,
} from "../sourceDocuments";

export const LEGAL_SOURCES_SCHEMA =
  "https://legaldatahunter.com/schemas/legal-sources/v1";
export const LEGAL_DATA_HUNTER_MCP_URL = "https://legaldatahunter.com/mcp";

export type ExternalSourceProvenance = {
  connectorId: string;
  serverUrl: string;
};

export type ExternalSourceExtractionContext = {
  toolName: string;
  arguments: Record<string, unknown>;
};

export type LegalDataHunterDocumentLocator = {
  connectorId: string;
  source: string;
  sourceId: string;
};

const MAX_CITATION_READY_SOURCES = 3;
const MAX_CANONICAL_TEXT_LENGTH = 50_000;
export const MAX_EXTERNAL_SOURCES_PER_TURN = 12;

const INVALID = Symbol("invalid");

type LegalSourceType = "case" | "legislation";

export type ExternalLegalSource = {
  document: SourceDocument;
  text: string;
  hydrated: boolean;
};

export type ExternalSourceStore = Map<string, ExternalLegalSource>;

export type RegisteredExternalSource = {
  handle: string;
  documentId: string;
  title: string;
  type: LegalSourceType;
};

type Invalid = typeof INVALID;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, maxLength: number): string | Invalid {
  if (typeof value !== "string") return INVALID;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return INVALID;
  return normalized;
}

function optionalString(
  value: unknown,
  maxLength: number,
): string | undefined | Invalid {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, maxLength);
}

function firstBoundedString(
  values: unknown[],
  maxLength: number,
): string | undefined {
  for (const value of values) {
    const bounded = optionalString(value, maxLength);
    if (bounded !== undefined && bounded !== INVALID) return bounded;
  }
  return undefined;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLegalDataHunterLocator(
  value: LegalDataHunterDocumentLocator,
): boolean {
  const sourceParts = value.source.split("/");
  return (
    /^[A-Za-z0-9_-]{1,128}$/.test(value.connectorId) &&
    sourceParts.length === 2 &&
    sourceParts.every((part) => /^[A-Za-z0-9._~-]{1,200}$/.test(part)) &&
    value.sourceId.length > 0 &&
    value.sourceId.length <= 2_048 &&
    !/[\u0000-\u001f\u007f]/.test(value.sourceId)
  );
}

export function legalDataHunterDocumentId(
  locator: LegalDataHunterDocumentLocator,
): string {
  if (!isLegalDataHunterLocator(locator)) {
    throw new Error("Invalid Legal Data Hunter document locator.");
  }
  const payload = Buffer.from(
    JSON.stringify([locator.connectorId, locator.source, locator.sourceId]),
    "utf8",
  ).toString("base64url");
  return `ldh:${payload}`;
}

export function parseLegalDataHunterDocumentId(
  documentId: string,
): LegalDataHunterDocumentLocator | null {
  if (!documentId.startsWith("ldh:") || documentId.length > 4_096) return null;
  try {
    const encoded = documentId.slice(4);
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      !parsed.every((value) => typeof value === "string")
    ) {
      return null;
    }
    const locator = {
      connectorId: parsed[0],
      source: parsed[1],
      sourceId: parsed[2],
    };
    if (!isLegalDataHunterLocator(locator)) return null;
    return legalDataHunterDocumentId(locator) === documentId ? locator : null;
  } catch {
    return null;
  }
}

function boundedCanonicalText(value: unknown): string | Invalid {
  if (typeof value !== "string") return INVALID;
  const normalized = value.trim();
  if (!normalized) return INVALID;
  return normalized.slice(0, MAX_CANONICAL_TEXT_LENGTH);
}

function legalSourceType(value: unknown): LegalSourceType | null {
  if (value === "case_law" || value === "case") return "case";
  if (value === "legislation") return "legislation";
  return null;
}

function sourceMetadata(
  value: Record<string, unknown>,
): SourceDocumentMetadata[] {
  const metadata: SourceDocumentMetadata[] = [];
  const citation = firstBoundedString(
    [value.ecli, value.case_number, value.identifier, value.citation],
    500,
  );
  const jurisdiction = firstBoundedString(
    [value.court, value.jurisdiction, value.authority, value.country],
    500,
  );
  const date = optionalString(value.date ?? value.effective_date, 10);
  if (citation) metadata.push({ label: "Citation", value: citation });
  if (jurisdiction) {
    metadata.push({ label: "Jurisdiction", value: jurisdiction });
  }
  if (date !== INVALID && date !== undefined && isIsoDate(date)) {
    metadata.push({ label: "Date", value: date, format: "date" });
  }
  return metadata;
}

function sourceActions(
  value: Record<string, unknown>,
): SourceDocumentAction[] | undefined | Invalid {
  const url = optionalString(value.url ?? value.official_url, 2_048);
  if (url === INVALID || (url !== undefined && !isHttpsUrl(url)))
    return INVALID;
  return url
    ? [
        {
          type: "link",
          url,
          label: "Official source",
          title: "Official source",
        },
      ]
    : undefined;
}

export function normalizeLegalDataHunterDocument(
  value: unknown,
  locator: LegalDataHunterDocumentLocator,
): SourceDocument | null {
  if (!isRecord(value) || !isLegalDataHunterLocator(locator)) return null;
  if (value.source !== locator.source || value.source_id !== locator.sourceId) {
    return null;
  }
  const title = requiredString(value.title, 500);
  const text = boundedCanonicalText(value.text);
  const type = legalSourceType(value.data_type);
  const actions = sourceActions(value);
  if (title === INVALID || text === INVALID || !type || actions === INVALID) {
    return null;
  }
  const documentId = legalDataHunterDocumentId(locator);
  return {
    document_id: documentId,
    title,
    type,
    metadata: sourceMetadata(value),
    actions,
    quotes: [],
    subdocuments: [
      {
        document_id: `${documentId}:text`,
        title,
        type: "html",
        text,
      },
    ],
  };
}

function normalizeSource(
  value: unknown,
  connectorId: string,
): ExternalLegalSource | null {
  if (!isRecord(value)) return null;

  const sourceId = requiredString(value.source_id, 512);
  const title = requiredString(value.title, 500);
  const citation = optionalString(value.citation, 500);
  const jurisdiction = optionalString(value.jurisdiction, 500);
  const date = optionalString(value.date, 10);
  const officialUrl = optionalString(value.official_url, 2_048);
  const text = requiredString(value.text, MAX_CANONICAL_TEXT_LENGTH);
  const sourceType = value.source_type;

  if (
    sourceId === INVALID ||
    title === INVALID ||
    citation === INVALID ||
    jurisdiction === INVALID ||
    date === INVALID ||
    officialUrl === INVALID ||
    text === INVALID ||
    (sourceType !== "case" && sourceType !== "legislation")
  ) {
    return null;
  }
  if (date !== undefined && !isIsoDate(date)) return null;
  if (officialUrl !== undefined && !isHttpsUrl(officialUrl)) return null;

  const documentId = `mcp:${connectorId}:${sourceId}`;
  const metadata: SourceDocumentMetadata[] = [];
  if (citation !== undefined) {
    metadata.push({ label: "Citation", value: citation });
  }
  if (jurisdiction !== undefined) {
    metadata.push({ label: "Jurisdiction", value: jurisdiction });
  }
  if (date !== undefined) {
    metadata.push({ label: "Date", value: date, format: "date" });
  }

  const actions: SourceDocumentAction[] | undefined = officialUrl
    ? [
        {
          type: "link",
          url: officialUrl,
          label: "Official source",
          title: "Official source",
        },
      ]
    : undefined;

  return {
    text,
    hydrated: true,
    document: {
      document_id: documentId,
      title,
      type: sourceType,
      metadata,
      actions,
      quotes: [],
      subdocuments: [
        {
          document_id: `${documentId}:text`,
          title,
          type: "html",
          text,
        },
      ],
    },
  };
}

function parseMcpTextJson(result: Record<string, unknown>): unknown | null {
  if (!Array.isArray(result.content)) return null;
  const textBlocks = result.content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (textBlocks.length !== 1) return null;
  const text = textBlocks[0].text as string;
  if (text.length > 60_000) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function searchVerificationText(value: Record<string, unknown>): string | null {
  const parts = [value.snippet, value.text, value.summary]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const text = Array.from(new Set(parts)).join("\n\n");
  return text && text.length <= MAX_CANONICAL_TEXT_LENGTH ? text : null;
}

function normalizeLegalDataHunterSearchHit(
  value: unknown,
  connectorId: string,
  type: LegalSourceType,
): ExternalLegalSource | null {
  if (!isRecord(value)) return null;
  const source = requiredString(value.source, 401);
  const sourceId = requiredString(value.source_id, 2_048);
  const title = requiredString(value.title, 500);
  const text = searchVerificationText(value);
  const actions = sourceActions(value);
  if (
    source === INVALID ||
    sourceId === INVALID ||
    title === INVALID ||
    !text ||
    actions === INVALID
  ) {
    return null;
  }
  const locator = { connectorId, source, sourceId };
  let documentId: string;
  try {
    documentId = legalDataHunterDocumentId(locator);
  } catch {
    return null;
  }
  return {
    text,
    hydrated: false,
    document: {
      document_id: documentId,
      title,
      type,
      metadata: sourceMetadata(value),
      actions,
      quotes: [],
    },
  };
}

function extractLegalDataHunterJsonSources(
  result: Record<string, unknown>,
  connectorId: string,
  context: ExternalSourceExtractionContext,
): ExternalLegalSource[] {
  const payload = parseMcpTextJson(result);
  if (context.toolName === "get_document" && isRecord(payload)) {
    const source = requiredString(payload.source, 401);
    const sourceId = requiredString(payload.source_id, 2_048);
    if (source === INVALID || sourceId === INVALID) return [];
    const locator = { connectorId, source, sourceId };
    const document = normalizeLegalDataHunterDocument(payload, locator);
    const text = boundedCanonicalText(payload.text);
    return document && text !== INVALID
      ? [{ document, text, hydrated: true }]
      : [];
  }
  if (context.toolName !== "search" || !isRecord(payload)) return [];
  const namespace = context.arguments.namespace ?? "case_law";
  const type = legalSourceType(namespace);
  if (!type || !Array.isArray(payload.hits)) return [];

  const normalized: ExternalLegalSource[] = [];
  const documentIds = new Set<string>();
  for (const hit of payload.hits) {
    if (normalized.length >= MAX_EXTERNAL_SOURCES_PER_TURN) break;
    const source = normalizeLegalDataHunterSearchHit(hit, connectorId, type);
    if (!source || documentIds.has(source.document.document_id)) continue;
    documentIds.add(source.document.document_id);
    normalized.push(source);
  }
  return normalized;
}

function isTrustedLegalDataHunterConnector(
  provenance: ExternalSourceProvenance,
): boolean {
  if (!provenance.connectorId.trim()) return false;
  try {
    return new URL(provenance.serverUrl).href === LEGAL_DATA_HUNTER_MCP_URL;
  } catch {
    return false;
  }
}

/**
 * Prefer the versioned structured-content contract. The current LDH server also
 * emits deterministic JSON in one text block for its allowlisted search and
 * document tools; arbitrary prose and unknown tools are never parsed.
 */
export function extractExternalLegalSources(
  result: unknown,
  provenance: ExternalSourceProvenance,
  resultWasTruncated = false,
  context?: ExternalSourceExtractionContext,
): ExternalLegalSource[] {
  if (
    resultWasTruncated ||
    !isTrustedLegalDataHunterConnector(provenance) ||
    !isRecord(result) ||
    result.isError === true
  ) {
    return [];
  }

  const envelope = isRecord(result.structuredContent)
    ? result.structuredContent
    : null;
  if (!envelope || envelope.schema === undefined) {
    return context
      ? extractLegalDataHunterJsonSources(
          result,
          provenance.connectorId,
          context,
        )
      : [];
  }
  if (envelope.schema !== LEGAL_SOURCES_SCHEMA) return [];
  if (!Array.isArray(envelope.sources)) return [];

  const citationReady = envelope.sources.filter(
    (source) => isRecord(source) && source.citation_ready === true,
  );
  if (citationReady.length > MAX_CITATION_READY_SOURCES) return [];

  const normalized: ExternalLegalSource[] = [];
  const sourceIds = new Set<string>();
  for (const source of citationReady) {
    const legalSource = normalizeSource(source, provenance.connectorId);
    if (!legalSource) return [];
    const sourceId = legalSource.document.document_id;
    if (sourceIds.has(sourceId)) return [];
    sourceIds.add(sourceId);
    normalized.push(legalSource);
  }
  return normalized;
}

export function registerExternalLegalSources(
  store: ExternalSourceStore,
  sources: ExternalLegalSource[],
): RegisteredExternalSource[] {
  const registered: RegisteredExternalSource[] = [];
  for (const source of sources) {
    const existing = Array.from(store.entries()).find(
      ([, candidate]) =>
        candidate.document.document_id === source.document.document_id,
    );

    let handle = existing?.[0];
    if (existing && handle) {
      const current = existing[1];
      if (current.hydrated && source.hydrated) {
        if (
          current.text !== source.text ||
          JSON.stringify(current.document) !== JSON.stringify(source.document)
        ) {
          continue;
        }
      } else if (!current.hydrated && source.hydrated) {
        store.set(handle, source);
      } else if (!current.hydrated && !source.hydrated) {
        const text = Array.from(new Set([current.text, source.text])).join(
          "\n\n",
        );
        if (text.length > MAX_CANONICAL_TEXT_LENGTH) continue;
        store.set(handle, { ...current, text });
      }
    } else {
      if (store.size >= MAX_EXTERNAL_SOURCES_PER_TURN) continue;
      let index = store.size;
      do {
        handle = `source-${index++}`;
      } while (store.has(handle));
      store.set(handle, source);
    }
    registered.push({
      handle,
      documentId: source.document.document_id,
      title: source.document.title,
      type: source.document.type as LegalSourceType,
    });
  }
  return registered;
}

/** The provider controls neither this instruction nor any interpolated text. */
export function buildExternalSourceCitationReminder(
  sources: RegisteredExternalSource[],
): string {
  if (sources.length === 0) return "";
  const handles = sources.map(({ handle, type }) => ({
    doc_id: handle,
    source_type: type,
  }));
  return [
    "Mike registered citation-ready legal sources for this assistant turn.",
    `Available handles: ${JSON.stringify(handles)}.`,
    'Cite claims from them in the final <CITATIONS> JSON using the registered "doc_id", an exact "quote", and the matching reference number. Do not cite unregistered legal-source identifiers.',
  ].join(" ");
}
