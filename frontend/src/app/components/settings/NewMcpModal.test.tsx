import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  LEGAL_DATA_HUNTER_MCP_PRESET,
  NewMcpModal,
} from "./NewMcpModal";

const existingDraft = {
  name: "Another server",
  serverUrl: "https://mcp.example.test/mcp",
  bearerToken: "secret-bearer-token",
  customHeaders: '{"X-API-Key":"secret"}',
};

describe("NewMcpModal Legal Data Hunter preset", () => {
  it("replaces a non-empty draft without retaining credentials or creating a connector", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

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
        onSubmit={onSubmit}
        onOpenConnector={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Use Legal Data Hunter" }),
    );

    expect(LEGAL_DATA_HUNTER_MCP_PRESET).toEqual({
      name: "Legal Data Hunter",
      serverUrl: "https://legaldatahunter.com/mcp",
    });
    expect(onDraftChange).toHaveBeenCalledWith({
      ...LEGAL_DATA_HUNTER_MCP_PRESET,
      bearerToken: "",
      customHeaders: "",
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
