# Legal Data Hunter

Mike can connect to Legal Data Hunter through Mike's existing remote MCP connector and OAuth flow. The integration does not add a separate direct API client or a Legal Data Hunter-specific credential store.

## Connect

1. Start Mike and sign in.
2. Open **Settings → Connectors → New MCP connector**.
3. Select **Use Legal Data Hunter**. Mike fills:
   - Label: `Legal Data Hunter`
   - URL: `https://legaldatahunter.com/mcp`
4. Leave **Bearer token** and **Advanced headers** empty.
5. Select **Connect**, complete Legal Data Hunter OAuth in the popup, and enable the legal-research tools you want Mike to use.

Mike accepts remote HTTPS MCP endpoints only. A localhost Legal Data Hunter MCP endpoint cannot be added through the connector UI.

The OAuth-protected MCP connection and generic Legal Data Hunter tool results are available now. The live Legal Data Hunter server does **not** yet emit the versioned source envelope described below, so native Mike citations remain inactive until that server-side contract is deployed.

## Test the connection now

Ask Mike a legal-research question that requires Legal Data Hunter, then confirm:

- the Legal Data Hunter MCP tool call appears in the assistant activity;
- the answer completes after the OAuth-protected call; and
- ordinary MCP tool output appears for search and document results.

## Test native citations after the LDH envelope is deployed

Only run these checks after Legal Data Hunter emits the exact `https://legaldatahunter.com/schemas/legal-sources/v1` envelope:

- a citation-ready case or legislation source appears in the **Citations** block;
- selecting the source opens canonical text in the existing legal-source panel;
- the citation quote is marked verified; and
- the official-source action opens an HTTPS URL.

## Structured legal-source contract

Generic MCP tool results continue to work as unstructured tool output. After Legal Data Hunter deploys the server-side contract, Mike creates native legal citation sources only when a tool result includes this exact versioned `structuredContent` envelope:

```json
{
  "schema": "https://legaldatahunter.com/schemas/legal-sources/v1",
  "sources": [
    {
      "source_id": "legal-data-hunter:case:stable-id",
      "source_type": "case",
      "title": "Decision title",
      "citation": "Official citation",
      "jurisdiction": "Court or jurisdiction",
      "date": "2025-01-15",
      "official_url": "https://official.example/source",
      "excerpt": "Search preview",
      "text": "Canonical retrievable text",
      "citation_ready": true
    }
  ]
}
```

Rules enforced by Mike:

- `schema` must match exactly;
- `source_type` must be `case` or `legislation`;
- only sources with `citation_ready: true` are registered;
- citation-ready sources require a stable non-empty `source_id`, title, and canonical text;
- dates must be real `YYYY-MM-DD` dates;
- official URLs, when present, must use HTTPS;
- canonical text is limited to 50,000 characters per source;
- at most three citation-ready sources and no duplicate source IDs are accepted per tool result;
- malformed or unknown envelopes are ignored rather than inferred from prose.

The request-scoped citation handles (`source-0`, `source-1`, and so on) exist only for one assistant turn. Persisted citations carry the normalized source document and remain usable after chat reload.

## Compatibility boundary

The connector and OAuth transport do not depend on this schema. If Legal Data Hunter returns legacy text-only results, Mike still passes those results to the model, but it does not guess legal metadata, expose an unverified source in the native panel, or treat a search preview as canonical citation text.
