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

const MAX_CITATION_READY_SOURCES = 3;
const MAX_CANONICAL_TEXT_LENGTH = 50_000;

const INVALID = Symbol("invalid");

type LegalSourceType = "case" | "legislation";

export type ExternalLegalSource = {
  document: SourceDocument;
  text: string;
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

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
 * Read only the versioned structuredContent contract. Legacy MCP text is never
 * parsed for legal-source fields, and a malformed citation-ready envelope is
 * ignored as a unit.
 */
export function extractExternalLegalSources(
  result: unknown,
  provenance: ExternalSourceProvenance,
  resultWasTruncated = false,
): ExternalLegalSource[] {
  if (
    resultWasTruncated ||
    !isTrustedLegalDataHunterConnector(provenance) ||
    !isRecord(result) ||
    result.isError === true ||
    !isRecord(result.structuredContent)
  ) {
    return [];
  }
  const envelope = result.structuredContent;
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
    if (
      existing &&
      (existing[1].text !== source.text ||
        JSON.stringify(existing[1].document) !== JSON.stringify(source.document))
    ) {
      continue;
    }

    let handle = existing?.[0];
    if (!handle) {
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
