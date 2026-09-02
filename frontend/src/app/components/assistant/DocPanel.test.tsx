import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocPanel, DocumentTitleRow } from "./DocPanel";

describe("DocumentTitleRow", () => {
    it("uses the shared compact title row with a file-type icon", () => {
        const { container } = render(
            <DocumentTitleRow
                document={{
                    document_id: "document-1",
                    title: "agreement.docx",
                    type: "docx",
                    metadata: [],
                    quotes: [],
                    version_id: "version-1",
                    version_number: 1,
                }}
                isReloading={false}
                compactActions={false}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "agreement.docx",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");
        expect(
            container.querySelector('img[src*="/icons/file-types/word.svg"]'),
        ).toBeInTheDocument();
    });

    it("uses pill-height source actions when the side panel is minimized", () => {
        render(
            <DocumentTitleRow
                document={{
                    document_id: "case:123",
                    title: "Example v Example",
                    type: "case",
                    metadata: [],
                    quotes: [],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.com/opinion.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Source",
                        },
                    ],
                }}
                isReloading={false}
                compactActions
            />,
        );

        expect(screen.getByRole("link", { name: "Download" })).toHaveClass(
            "h-6",
            "w-6",
        );
        expect(screen.getByRole("link", { name: "Source" })).toHaveClass(
            "h-6",
            "w-6",
        );
    });

    it("renders only HTTPS external actions", () => {
        const { container } = render(
            <DocumentTitleRow
                document={{
                    document_id: "case:unsafe-actions",
                    title: "Unsafe actions",
                    type: "case",
                    metadata: [],
                    quotes: [],
                    actions: [
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "HTTPS source",
                        },
                        {
                            type: "link",
                            url: "http://example.com/source",
                            label: "HTTP source",
                        },
                        {
                            type: "download",
                            url: "javascript:alert(1)",
                            label: "JavaScript download",
                        },
                        {
                            type: "download",
                            url: "data:text/plain,unsafe",
                            label: "Data download",
                        },
                    ],
                }}
                isReloading={false}
                compactActions={false}
            />,
        );

        expect(
            screen.getByRole("link", { name: "HTTPS source" }),
        ).toHaveAttribute("href", "https://example.com/source");
        expect(
            screen.queryByRole("link", { name: "HTTP source" }),
        ).not.toBeInTheDocument();
        expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
        expect(container.querySelector('a[href^="data:"]')).toBeNull();
        expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    });
});

describe("case document", () => {
    it("uses the same title row for normalized metadata and actions", () => {
        const { container } = render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "case:123",
                    title: "Example v Example, [2024] UKSC 1",
                    type: "case",
                    metadata: [
                        {
                            label: "Date",
                            value: "2024-01-02",
                            format: "date",
                        },
                    ],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.com/opinion.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Link",
                        },
                    ],
                    quotes: [],
                    subdocuments: [
                        {
                            document_id: "case:123:opinion:456",
                            title: "Lead Opinion by Justice Example",
                            type: "html",
                            html: "<p>Opinion text.</p>",
                            text: null,
                        },
                    ],
                }}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "Example v Example, [2024] UKSC 1",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");

        const metadata = screen.getByText("Date: January 2, 2024");
        expect(metadata.parentElement).toHaveClass("w-full");
        expect(metadata.parentElement).not.toBe(title.parentElement);

        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "https://example.com/opinion.pdf",
        );
        expect(screen.getByRole("link", { name: "Link" })).toHaveAttribute(
            "href",
            "https://example.com/source",
        );
        expect(
            container.querySelector(
                'img[src*="/icons/legal-sources/case-law.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
        expect(screen.getByText("Opinion text.")).toBeInTheDocument();
    });

    it("keeps only HTTPS links in provider-supplied legal HTML", () => {
        render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "case:unsafe-html",
                    title: "Unsafe HTML links",
                    type: "case",
                    metadata: [],
                    quotes: [],
                    subdocuments: [
                        {
                            document_id: "case:unsafe-html:text",
                            title: "Opinion",
                            type: "html",
                            html: [
                                '<a href="https://example.com/safe">HTTPS</a>',
                                '<a href="http://example.com/unsafe">HTTP</a>',
                                '<a href="mailto:test@example.com">Mail</a>',
                            ].join(" "),
                            text: null,
                        },
                    ],
                }}
            />,
        );

        expect(screen.getByRole("link", { name: "HTTPS" })).toHaveAttribute(
            "href",
            "https://example.com/safe",
        );
        expect(screen.getByText("HTTP")).not.toHaveAttribute("href");
        expect(screen.getByText("Mail")).not.toHaveAttribute("href");
    });
});

describe("legislation document", () => {
    it("renders canonical text in the legal-source viewer without an internal PDF", () => {
        const { container } = render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "legal-data-hunter:legislation:LEGIARTI000001",
                    title: "Code civil, article 1103",
                    type: "legislation",
                    metadata: [
                        { label: "Citation", value: "Article 1103" },
                    ],
                    actions: [
                        {
                            type: "link",
                            url: "https://www.legifrance.gouv.fr/example",
                            label: "Official source",
                        },
                    ],
                    quotes: [],
                    subdocuments: [
                        {
                            document_id:
                                "legal-data-hunter:legislation:LEGIARTI000001:text",
                            title: "Code civil, article 1103",
                            type: "html",
                            text: "Les contrats légalement formés tiennent lieu de loi.",
                        },
                    ],
                }}
            />,
        );

        expect(
            screen.getByText(
                "Les contrats légalement formés tiennent lieu de loi.",
            ),
        ).toBeInTheDocument();
        expect(
            container.querySelector(
                'img[src*="/icons/legal-sources/legislation.svg"]',
            ),
        ).toBeInTheDocument();
        expect(container.querySelector("canvas")).not.toBeInTheDocument();
    });
});
