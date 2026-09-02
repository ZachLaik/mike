import { describe, expect, it } from "vitest";
import {
  LEGAL_SOURCES_SCHEMA,
  buildExternalSourceCitationReminder,
  extractExternalLegalSources,
  registerExternalLegalSources,
  type ExternalSourceStore,
} from "./sourceDocuments";

const PROVENANCE = {
  connectorId: "connector-1",
  serverUrl: "https://legaldatahunter.com/mcp",
};

function extract(result: unknown, resultWasTruncated = false) {
  return extractExternalLegalSources(result, PROVENANCE, resultWasTruncated);
}

function mcpResult(sources: unknown[]) {
  return {
    content: [{ type: "text", text: "Legacy MCP result" }],
    structuredContent: {
      schema: LEGAL_SOURCES_SCHEMA,
      sources,
    },
  };
}

function legalSource(overrides: Record<string, unknown> = {}) {
  return {
    source_id: "legal-data-hunter:case:ccass-2025-001",
    source_type: "case",
    title: "Cour de cassation, chambre commerciale",
    citation: "Pourvoi n° 24-10.001",
    jurisdiction: "Cour de cassation",
    date: "2025-01-15",
    official_url: "https://www.legifrance.gouv.fr/example",
    excerpt: "La Cour rejette le pourvoi.",
    text: "Attendu que la Cour rejette le pourvoi.",
    citation_ready: true,
    ...overrides,
  };
}

describe("MCP legal source structured content", () => {
  it("normalizes a citation-ready case without parsing legacy prose", () => {
    const [source] = extract(mcpResult([legalSource()]));

    expect(source.text).toBe("Attendu que la Cour rejette le pourvoi.");
    expect(source.document).toEqual({
      document_id: "mcp:connector-1:legal-data-hunter:case:ccass-2025-001",
      title: "Cour de cassation, chambre commerciale",
      type: "case",
      metadata: [
        { label: "Citation", value: "Pourvoi n° 24-10.001" },
        { label: "Jurisdiction", value: "Cour de cassation" },
        { label: "Date", value: "2025-01-15", format: "date" },
      ],
      actions: [
        {
          type: "link",
          url: "https://www.legifrance.gouv.fr/example",
          label: "Official source",
          title: "Official source",
        },
      ],
      quotes: [],
      subdocuments: [
        {
          document_id:
            "mcp:connector-1:legal-data-hunter:case:ccass-2025-001:text",
          title: "Cour de cassation, chambre commerciale",
          type: "html",
          text: "Attendu que la Cour rejette le pourvoi.",
        },
      ],
    });
  });

  it("normalizes legislation and keeps optional metadata optional", () => {
    const [source] = extract(
      mcpResult([
        legalSource({
          source_id: "legal-data-hunter:legislation:LEGIARTI000001",
          source_type: "legislation",
          title: "Code civil, article 1103",
          citation: "Article 1103",
          jurisdiction: undefined,
          date: undefined,
          official_url: undefined,
          text: "Les contrats légalement formés tiennent lieu de loi.",
        }),
      ]),
    );

    expect(source.document).toMatchObject({
      document_id:
        "mcp:connector-1:legal-data-hunter:legislation:LEGIARTI000001",
      type: "legislation",
      metadata: [{ label: "Citation", value: "Article 1103" }],
      actions: undefined,
    });
  });

  it("ignores an MCP error result even when its structured content is valid", () => {
    expect(
      extract({
        ...mcpResult([legalSource()]),
        isError: true,
      }),
    ).toEqual([]);
  });

  it("ignores search previews that are not citation-ready", () => {
    expect(
      extract(
        mcpResult([legalSource({ citation_ready: false })]),
      ),
    ).toEqual([]);
  });

  it.each([
    ["unknown schema", { schema: "https://example.test/v2", sources: [legalSource()] }],
    ["missing source ID", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ source_id: "" })] }],
    ["unknown source type", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ source_type: "web" })] }],
    ["non-HTTPS URL", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ official_url: "http://example.test" })] }],
    ["invalid date", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ date: "2025-02-31" })] }],
    ["missing canonical text", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ text: "" })] }],
    ["oversized canonical text", { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ text: "x".repeat(50_001) })] }],
  ])("ignores a malformed envelope: %s", (_label, structuredContent) => {
    expect(extract({ structuredContent })).toEqual([]);
  });

  it("rejects duplicate source IDs and more than three citation-ready sources", () => {
    expect(
      extract(mcpResult([legalSource(), legalSource()])),
    ).toEqual([]);

    expect(
      extract(
        mcpResult(
          Array.from({ length: 4 }, (_, index) =>
            legalSource({ source_id: `legal-data-hunter:case:${index}` }),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects the LDH schema from any connector except the exact LDH MCP endpoint", () => {
    expect(
      extractExternalLegalSources(
        mcpResult([legalSource()]),
        {
          connectorId: "connector-1",
          serverUrl: "https://attacker.example/mcp",
        },
        false,
      ),
    ).toEqual([]);
  });

  it("rejects citation-ready sources when the MCP result was truncated", () => {
    expect(extract(mcpResult([legalSource()]), true)).toEqual([]);
  });
});

describe("turn-scoped external source registration", () => {
  it("assigns short handles and reuses a handle for the same canonical source", () => {
    const store: ExternalSourceStore = new Map();
    const [source] = extract(mcpResult([legalSource()]));

    expect(registerExternalLegalSources(store, [source])).toEqual([
      {
        handle: "source-0",
        documentId:
          "mcp:connector-1:legal-data-hunter:case:ccass-2025-001",
        title: "Cour de cassation, chambre commerciale",
        type: "case",
      },
    ]);
    expect(registerExternalLegalSources(store, [source])[0]?.handle).toBe(
      "source-0",
    );
    expect(store).toHaveLength(1);
  });

  it("rejects a conflicting redefinition of the same connector source ID", () => {
    const store: ExternalSourceStore = new Map();
    const [source] = extract(mcpResult([legalSource()]));
    const conflicting = {
      ...source,
      text: "Different canonical text.",
      document: {
        ...source.document,
        subdocuments: source.document.subdocuments?.map((subdocument) => ({
          ...subdocument,
          text: "Different canonical text.",
        })),
      },
    };

    expect(registerExternalLegalSources(store, [source])).toHaveLength(1);
    expect(registerExternalLegalSources(store, [conflicting])).toEqual([]);
    expect(store.get("source-0")?.text).toBe(source.text);
  });

  it("builds Mike-authored citation instructions using only registered handles", () => {
    expect(
      buildExternalSourceCitationReminder([
        {
          handle: "source-0",
          documentId: "legal-data-hunter:case:ccass-2025-001",
          title: "Untrusted title",
          type: "case",
        },
      ]),
    ).toContain('"doc_id":"source-0"');
    expect(
      buildExternalSourceCitationReminder([
        {
          handle: "source-0",
          documentId: "legal-data-hunter:case:ccass-2025-001",
          title: "Untrusted title",
          type: "case",
        },
      ]),
    ).not.toContain("Untrusted title");
  });
});
