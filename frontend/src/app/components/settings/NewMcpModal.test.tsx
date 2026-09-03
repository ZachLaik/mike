import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewMcpModal } from "./NewMcpModal";

const existingDraft = {
    name: "Another server",
    serverUrl: "https://mcp.example.test/mcp",
    bearerToken: "secret-bearer-token",
    customHeaders: '{"X-API-Key":"secret"}',
};

describe("NewMcpModal", () => {
    it("stays provider-neutral for custom MCP servers", () => {
        const onDraftChange = vi.fn();

        render(
            <NewMcpModal
                open
                draft={existingDraft}
                step="form"
                result={null}
                error={null}
                authMessage={null}
                showToken={false}
                showAdvanced={false}
                onDraftChange={onDraftChange}
                onShowTokenChange={vi.fn()}
                onShowAdvancedChange={vi.fn()}
                onClose={vi.fn()}
                onSubmit={vi.fn().mockResolvedValue(undefined)}
                onOpenConnector={vi.fn()}
            />,
        );

        expect(
            screen.queryByRole("button", { name: "Use Legal Data Hunter" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue(
            existingDraft.name,
        );
        expect(
            screen.getByRole("textbox", { name: "URL endpoint" }),
        ).toHaveValue(existingDraft.serverUrl);
        expect(onDraftChange).not.toHaveBeenCalled();
    });
});
