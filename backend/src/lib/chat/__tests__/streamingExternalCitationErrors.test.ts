import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSourceStore } from "../../mcp/sourceDocuments";

const { streamChatWithTools, runToolCalls } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
  runToolCalls: vi.fn(),
}));

vi.mock("../../llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../llm/models")),
  streamChatWithTools: (...args: unknown[]) => streamChatWithTools(...args),
}));

vi.mock("../../mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (...args: unknown[]) => runToolCalls(...args),
}));

import {
  AssistantStreamError,
  runLLMStream,
  type AssistantEvent,
} from "../streaming";

const canonicalText = "Attendu que la Cour rejette le pourvoi.";
const quotedText = "La Cour rejette le pourvoi.";
const verifiedQuotedText = "la Cour rejette le pourvoi.";

function fakeDb(): never {
  return {} as never;
}

function baseParams() {
  return {
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: fakeDb(),
    write: vi.fn(),
    model: "gemini-3-flash-preview",
  };
}

function toolCallResult() {
  return {
    toolResults: [
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "Legal source registered as source-0.",
      },
    ],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runToolCalls.mockImplementation(async (...args: unknown[]) => {
    const store = args[14] as ExternalSourceStore | undefined;
    store?.set("source-0", {
      text: canonicalText,
      document: {
        document_id: "legal-data-hunter:case:ccass-2025-001",
        title: "Cour de cassation, chambre commerciale",
        type: "case",
        metadata: [
          { label: "Citation", value: "Pourvoi n° 24-10.001" },
          { label: "Jurisdiction", value: "Cour de cassation" },
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
            document_id: "legal-data-hunter:case:ccass-2025-001:text",
            title: "Cour de cassation, chambre commerciale",
            type: "html",
            text: canonicalText,
          },
        ],
      },
    });
    return toolCallResult();
  });
});

describe("runLLMStream external citation error persistence", () => {
  it.each([
    [
      "cancellation",
      () => {
        const error = new Error("Stream aborted.");
        error.name = "AbortError";
        return error;
      },
    ],
    ["failure", () => new Error("provider failed")],
  ])(
    "carries a verified reload-compatible external citation through %s",
    async (_path, makeError) => {
      streamChatWithTools.mockImplementation(
        async (params: {
          callbacks: { onContentDelta: (delta: string) => void };
          runTools?: (
            calls: { id: string; name: string; input: Record<string, unknown> }[],
          ) => Promise<unknown>;
        }) => {
          await params.runTools?.([
            { id: "call-1", name: "mcp_legal_data_hunter", input: {} },
          ]);
          params.callbacks.onContentDelta(
            `Answer [1]\n<CITATIONS>[${JSON.stringify({
              ref: 1,
              doc_id: "source-0",
              quote: quotedText,
            })}]`,
          );
          throw makeError();
        },
      );
      const params = baseParams();

      let caught: unknown;
      try {
        await runLLMStream(params);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AssistantStreamError);
      const streamError = caught as AssistantStreamError & {
        citations?: unknown[];
        events: AssistantEvent[];
      };
      expect(params.write).toHaveBeenCalledWith(
        expect.stringContaining('"status":"partial"'),
      );
      expect(params.write).toHaveBeenCalledWith(
        expect.stringContaining('"status":"final"'),
      );

      const reloaded = JSON.parse(
        JSON.stringify(streamError.citations),
      ) as Record<string, unknown>[];
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({
        type: "citation_data",
        kind: "document",
        ref: 1,
        doc_id: "source-0",
        document_id: "legal-data-hunter:case:ccass-2025-001",
        filename: "Cour de cassation, chambre commerciale",
        verified: true,
        quote: verifiedQuotedText,
        quotes: [
          {
            quote: verifiedQuotedText,
            verification: {
              verified: true,
              source_excerpt: verifiedQuotedText,
            },
          },
        ],
        document: {
          document_id: "legal-data-hunter:case:ccass-2025-001",
          title: "Cour de cassation, chambre commerciale",
          type: "case",
          metadata: [
            { label: "Citation", value: "Pourvoi n° 24-10.001" },
            { label: "Jurisdiction", value: "Cour de cassation" },
          ],
          actions: [
            {
              type: "link",
              url: "https://www.legifrance.gouv.fr/example",
              label: "Official source",
              title: "Official source",
            },
          ],
          quotes: [
            {
              quote: verifiedQuotedText,
              target: {
                subdocument_id:
                  "legal-data-hunter:case:ccass-2025-001:text",
              },
              verification: {
                verified: true,
                source_excerpt: verifiedQuotedText,
              },
            },
          ],
          subdocuments: [
            {
              document_id: "legal-data-hunter:case:ccass-2025-001:text",
              type: "html",
              text: canonicalText,
            },
          ],
        },
      });
    },
  );
});
