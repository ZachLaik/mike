import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "../sourceDocuments";
import {
  cacheExternalSourceDocument,
  loadCachedExternalSourceDocument,
} from "./sourceDocumentCache";

const document: SourceDocument = {
  document_id: "ldh:opaque-handle",
  title: "Cour de cassation",
  type: "case",
  metadata: [],
  quotes: [],
  subdocuments: [
    {
      document_id: "ldh:opaque-handle:text",
      title: "Cour de cassation",
      type: "html",
      text: "Canonical text",
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("external source document cache", () => {
  it("loads only a non-expired document for the authenticated user and handle", async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: { document },
      error: null,
    }));
    const from = vi.fn(() => chain);

    await expect(
      loadCachedExternalSourceDocument(
        { from } as never,
        "user-1",
        document.document_id,
      ),
    ).resolves.toEqual(document);
    expect(from).toHaveBeenCalledWith("user_external_source_documents");
    expect(chain.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(chain.eq).toHaveBeenNthCalledWith(
      2,
      "document_id",
      document.document_id,
    );
    expect(chain.eq).toHaveBeenNthCalledWith(
      3,
      "provider",
      "legal-data-hunter",
    );
    expect(chain.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });

  it("rejects a cached payload bound to a different handle", async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: {
        document: { ...document, document_id: "ldh:different-handle" },
      },
      error: null,
    }));

    await expect(
      loadCachedExternalSourceDocument(
        { from: vi.fn(() => chain) } as never,
        "user-1",
        document.document_id,
      ),
    ).resolves.toBeNull();
  });

  it("stores case law for 24 hours using a user-scoped upsert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:00:00.000Z"));
    const upsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ upsert }));

    await cacheExternalSourceDocument({ from } as never, "user-1", document);

    expect(from).toHaveBeenCalledWith("user_external_source_documents");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "user-1",
        document_id: document.document_id,
        provider: "legal-data-hunter",
        document,
        expires_at: "2026-09-04T08:00:00.000Z",
        updated_at: "2026-09-03T08:00:00.000Z",
      },
      { onConflict: "user_id,document_id" },
    );
  });
});
