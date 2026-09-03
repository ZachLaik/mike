import { describe, expect, it } from "vitest";
import {
  LEGAL_SOURCES_SCHEMA,
  buildExternalSourceCitationReminder,
  extractExternalLegalSources,
  legalDataHunterDocumentId,
  MAX_EXTERNAL_SOURCES_PER_TURN,
  parseLegalDataHunterDocumentId,
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
      extract(mcpResult([legalSource({ citation_ready: false })])),
    ).toEqual([]);
  });

  it.each([
    [
      "unknown schema",
      { schema: "https://example.test/v2", sources: [legalSource()] },
    ],
    [
      "missing source ID",
      {
        schema: LEGAL_SOURCES_SCHEMA,
        sources: [legalSource({ source_id: "" })],
      },
    ],
    [
      "unknown source type",
      {
        schema: LEGAL_SOURCES_SCHEMA,
        sources: [legalSource({ source_type: "web" })],
      },
    ],
    [
      "non-HTTPS URL",
      {
        schema: LEGAL_SOURCES_SCHEMA,
        sources: [legalSource({ official_url: "http://example.test" })],
      },
    ],
    [
      "invalid date",
      {
        schema: LEGAL_SOURCES_SCHEMA,
        sources: [legalSource({ date: "2025-02-31" })],
      },
    ],
    [
      "missing canonical text",
      { schema: LEGAL_SOURCES_SCHEMA, sources: [legalSource({ text: "" })] },
    ],
    [
      "oversized canonical text",
      {
        schema: LEGAL_SOURCES_SCHEMA,
        sources: [legalSource({ text: "x".repeat(50_001) })],
      },
    ],
  ])("ignores a malformed envelope: %s", (_label, structuredContent) => {
    expect(extract({ structuredContent })).toEqual([]);
  });

  it("rejects duplicate source IDs and more than three citation-ready sources", () => {
    expect(extract(mcpResult([legalSource(), legalSource()]))).toEqual([]);

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
        documentId: "mcp:connector-1:legal-data-hunter:case:ccass-2025-001",
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

  it("caps the aggregate request-scoped source store", () => {
    const store: ExternalSourceStore = new Map();
    const [baseSource] = extract(mcpResult([legalSource()]));

    for (let index = 0; index < MAX_EXTERNAL_SOURCES_PER_TURN + 1; index += 1) {
      registerExternalLegalSources(store, [
        {
          ...baseSource,
          text: `Decision text ${index}`,
          document: {
            ...baseSource.document,
            document_id: `mcp:connector-1:legal-data-hunter:case:${index}`,
            subdocuments: baseSource.document.subdocuments?.map(
              (subdocument) => ({
                ...subdocument,
                document_id: `mcp:connector-1:legal-data-hunter:case:${index}:text`,
                text: `Decision text ${index}`,
              }),
            ),
          },
        },
      ]);
    }

    expect(store.size).toBe(MAX_EXTERNAL_SOURCES_PER_TURN);
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

  it("registers trusted LDH JSON search hits as lazy native-source stubs", () => {
    const sources = extractExternalLegalSources(
      {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query: "contract formation",
              total_hits: 1,
              elapsed_ms: 12,
              hits: [
                {
                  id: "FR/CASS::JURITEXT000006994248",
                  source: "FR/CASS",
                  source_id: "JURITEXT000006994248",
                  title: "Cour de cassation, 27 octobre 1975",
                  snippet:
                    "The agreement was formed when acceptance was received.",
                  url: "https://www.legifrance.gouv.fr/juri/id/JURITEXT000006994248",
                  country: "FR",
                  court: "Cour de cassation",
                  date: "1975-10-27",
                  ecli: "ECLI:FR:CCASS:1975:TEST",
                },
              ],
            }),
          },
        ],
      },
      PROVENANCE,
      false,
      { toolName: "search", arguments: { namespace: "case_law" } },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      text: "The agreement was formed when acceptance was received.",
      hydrated: false,
      document: {
        type: "case",
        title: "Cour de cassation, 27 octobre 1975",
        actions: [
          {
            type: "link",
            url: "https://www.legifrance.gouv.fr/juri/id/JURITEXT000006994248",
            label: "Official source",
            title: "Official source",
          },
        ],
      },
    });
    expect(sources[0].document.subdocuments).toBeUndefined();
    expect(
      parseLegalDataHunterDocumentId(sources[0].document.document_id),
    ).toEqual({
      connectorId: "connector-1",
      source: "FR/CASS",
      sourceId: "JURITEXT000006994248",
    });
  });

  it("normalizes a trusted LDH get_document result as hydrated", () => {
    const sources = extractExternalLegalSources(
      {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
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
          },
        ],
      },
      PROVENANCE,
      false,
      { toolName: "get_document", arguments: {} },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      text: "Full canonical judgment text.",
      hydrated: true,
      document: {
        type: "case",
        title: "Cour de cassation, 27 octobre 1975",
      },
    });
    expect(sources[0].document.subdocuments?.[0]?.text).toBe(
      "Full canonical judgment text.",
    );
  });

  it("bounds LDH metadata before returning a native source", () => {
    const [source] = extractExternalLegalSources(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "FR/CASS",
              source_id: "JURITEXT000006994248",
              data_type: "case_law",
              title: "Cour de cassation",
              text: "Full canonical judgment text.",
              ecli: "x".repeat(501),
              court: "y".repeat(501),
              country: "FR",
              date: "1975-10-27",
            }),
          },
        ],
      },
      PROVENANCE,
      false,
      { toolName: "get_document", arguments: {} },
    );

    expect(source.document.metadata).toEqual([
      { label: "Jurisdiction", value: "FR" },
      { label: "Date", value: "1975-10-27", format: "date" },
    ]);
  });

  it("does not infer LDH IDs from prose or unrecognized tools", () => {
    expect(
      extractExternalLegalSources(
        { content: [{ type: "text", text: "source_id: guessed-id" }] },
        PROVENANCE,
        false,
        { toolName: "search", arguments: { namespace: "case_law" } },
      ),
    ).toEqual([]);
    expect(
      extractExternalLegalSources(
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hits: [
                  {
                    source: "FR/CASS",
                    source_id: "trusted-id",
                    title: "Title",
                    snippet: "Snippet",
                  },
                ],
              }),
            },
          ],
        },
        PROVENANCE,
        false,
        { toolName: "other_tool", arguments: {} },
      ),
    ).toEqual([]);
  });

  it("round-trips only well-formed opaque LDH document handles", () => {
    const documentId = legalDataHunterDocumentId({
      connectorId: "connector-1",
      source: "US/CaselawAccessProject",
      sourceId: "us_462/html/0416-01.html",
    });
    expect(parseLegalDataHunterDocumentId(documentId)).toEqual({
      connectorId: "connector-1",
      source: "US/CaselawAccessProject",
      sourceId: "us_462/html/0416-01.html",
    });
    expect(parseLegalDataHunterDocumentId("ldh:not-base64")).toBeNull();
    expect(
      parseLegalDataHunterDocumentId("mcp:connector-1:guessed"),
    ).toBeNull();
  });
});
