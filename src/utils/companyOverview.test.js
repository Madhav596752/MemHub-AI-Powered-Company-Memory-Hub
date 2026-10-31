import { describe, it, expect } from "vitest";
import {
  documentCounts, graphTotals, totalBytes, typeBreakdown, uploadsByMonth,
  processingOutcomes, topDocumentsByEntities, recentActivity, formatBytes, formatRelative,
} from "./companyOverview";

const ing = (status, extra = {}) => ({ status, entityCount: 0, relationshipCount: 0, errorCode: null, processedAt: null, updatedAt: "2026-09-01T10:00:00.000Z", ...extra });
const doc = (id, extra = {}) => ({ id, originalName: `${id}.pdf`, fileType: "PDF", fileSize: 1000, createdAt: "2026-09-01T09:00:00.000Z", uploader: { id: "u", name: "Priya" }, graphIngestion: null, ...extra });

describe("documentCounts", () => {
  it("uses the server aggregation when /api/graph/status loaded", () => {
    const status = { data: { documents: { total: 9, processed: 5, failed: 2, skipped: 1, notProcessed: 1 } } };
    expect(documentCounts(status, { data: [] })).toEqual({ total: 9, processed: 5, failed: 2, skipped: 1, awaiting: 1, source: "server" });
  });
  it("falls back to tallying the document list, never inventing numbers", () => {
    const docs = [doc("a", { graphIngestion: ing("processed") }), doc("b", { graphIngestion: ing("failed") }), doc("c", { graphIngestion: ing("skipped") }), doc("d"), doc("e", { graphIngestion: ing("weird") })];
    expect(documentCounts({ data: null, error: "x" }, { data: docs })).toEqual({ total: 5, processed: 1, failed: 1, skipped: 1, awaiting: 2, source: "documents" });
  });
  it("returns null (unknown) when nothing loaded", () => {
    expect(documentCounts({ data: null, error: "x" }, { data: null, error: "y" })).toBeNull();
  });
});

describe("graphTotals", () => {
  it("is unknown (not zero) on error or when the graph is off", () => {
    expect(graphTotals({ data: null, error: "down" })).toEqual({ available: false, reason: "down" });
    expect(graphTotals({ data: { enabled: false, stats: { entities: 0, relationships: 0 } }, error: "" }).available).toBe(false);
    expect(graphTotals({ data: null, error: "" }).available).toBe(false);
  });
  it("reads the real totals", () => {
    expect(graphTotals({ data: { enabled: true, stats: { entities: 31, relationships: 17 } }, error: "" })).toEqual({ available: true, entities: 31, relationships: 17 });
    expect(graphTotals({ data: { enabled: true, stats: { entities: 0, relationships: 0 } }, error: "" })).toEqual({ available: true, entities: 0, relationships: 0 });
  });
});

describe("groupings", () => {
  it("totals storage and groups types, largest first", () => {
    const docs = [doc("a"), doc("b", { fileType: "DOCX", fileSize: 500 }), doc("c")];
    expect(totalBytes(docs)).toBe(2500);
    expect(typeBreakdown(docs)).toEqual([{ name: "PDF", value: 2 }, { name: "DOCX", value: 1 }]);
    expect(typeBreakdown([])).toEqual([]);
  });

  it("buckets uploads by month over the last 12 months and reports older ones separately", () => {
    const now = new Date(2026, 9, 25); // 25 Oct 2026
    const docs = [
      doc("a", { createdAt: new Date(2026, 9, 1).toISOString() }),
      doc("b", { createdAt: new Date(2026, 9, 20).toISOString() }),
      doc("c", { createdAt: new Date(2026, 7, 5).toISOString() }),
      doc("d", { createdAt: new Date(2025, 10, 5).toISOString() }), // Nov 2025 = first bucket
      doc("e", { createdAt: new Date(2025, 9, 5).toISOString() }), // Oct 2025 = too old
      doc("f", { createdAt: "not-a-date" }),
    ];
    const { months, earlier } = uploadsByMonth(docs, now);
    expect(months).toHaveLength(12);
    expect(months[11].docs).toBe(2);
    expect(months[9].docs).toBe(1);
    expect(months[0].docs).toBe(1);
    expect(months.reduce((n, m) => n + m.docs, 0)).toBe(4);
    expect(earlier).toBe(1);
  });

  it("lists outcomes from the counts and ranks documents by extracted entities", () => {
    expect(processingOutcomes(null)).toEqual([]);
    expect(processingOutcomes({ processed: 3, failed: 1, skipped: 0, awaiting: 2 }).map((o) => o.value)).toEqual([3, 1, 0, 2]);
    const docs = [
      doc("a", { graphIngestion: ing("processed", { entityCount: 4, relationshipCount: 2 }) }),
      doc("b", { graphIngestion: ing("processed", { entityCount: 9, relationshipCount: 5 }) }),
      doc("c", { graphIngestion: ing("failed", { entityCount: 50 }) }), // failed: not ranked
      doc("d", { graphIngestion: ing("processed", { entityCount: 0 }) }), // nothing extracted
    ];
    expect(topDocumentsByEntities(docs).map((d) => d.id)).toEqual(["b", "a"]);
  });
});

describe("recentActivity", () => {
  it("builds only real events, newest first, and limits them", () => {
    const docs = [
      doc("a", { createdAt: "2026-09-01T09:00:00.000Z", graphIngestion: ing("processed", { entityCount: 3, relationshipCount: 1, updatedAt: "2026-09-01T09:01:00.000Z" }) }),
      doc("b", { createdAt: "2026-09-02T09:00:00.000Z", uploader: null, graphIngestion: ing("failed", { updatedAt: "2026-09-02T09:02:00.000Z" }) }),
      doc("c", { createdAt: "2026-09-03T09:00:00.000Z", graphIngestion: ing("skipped", { updatedAt: "2026-09-03T09:05:00.000Z" }) }),
    ];
    const ev = recentActivity(docs, 10);
    expect(ev.map((e) => e.id)).toEqual(["c:upload", "b:failed", "b:upload", "a:processed", "a:upload"]);
    expect(ev.find((e) => e.id === "b:upload").detail).toBe("Uploaded");
    expect(ev.find((e) => e.id === "a:processed").detail).toContain("3 entities · 1 relationships");
    expect(recentActivity(docs, 2)).toHaveLength(2);
    expect(recentActivity([])).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats sizes and relative times", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(undefined)).toBe("—");
    const now = new Date("2026-10-25T12:00:00Z");
    expect(formatRelative("2026-10-25T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-25T11:30:00Z", now)).toBe("30m ago");
    expect(formatRelative("2026-10-25T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelative("2026-10-22T12:00:00Z", now)).toBe("3d ago");
    expect(formatRelative("garbage", now)).toBe("");
  });
});
