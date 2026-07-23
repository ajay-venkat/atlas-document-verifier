"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  StreamEvent,
  VerificationReport,
  ClaimResult,
} from "@/lib/types";

// ---- Types for local state ----

interface DocumentMeta {
  id: string;
  title: string;
  source_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---- Main Page Component ----

export default function Home() {
  const [activeTab, setActiveTab] = useState<"upload" | "verify">("upload");

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/30 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/20 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold gradient-text">
                Atlas Verifier
              </h1>
              <p className="text-xs text-muted-foreground">
                Multi-Agent Document Verification Engine
              </p>
            </div>
          </div>

          <nav className="flex gap-1 bg-secondary/50 rounded-lg p-1">
            <button
              onClick={() => setActiveTab("upload")}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                activeTab === "upload"
                  ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              📄 Corpus
            </button>
            <button
              onClick={() => setActiveTab("verify")}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                activeTab === "verify"
                  ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              🔍 Verify
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
        {activeTab === "upload" ? <CorpusView /> : <VerifyView />}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 py-4 text-center text-xs text-muted-foreground">
        Built for Smart India Hackathon — Hybrid RAG + Multi-Agent Verification
      </footer>
    </div>
  );
}

// ==============================================================
// CORPUS VIEW — Upload + List Documents
// ==============================================================

function CorpusView() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDocuments(data.documents || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch documents");
    } finally {
      setIsLoading(false);
      setHasFetched(true);
    }
  }, []);

  // Fetch on first render
  if (!hasFetched && !isLoading) {
    fetchDocuments();
  }

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadResult(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source_type", "general");

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setUploadResult(
        `✅ "${file.name}" ingested — ${data.chunks_created} chunks, ${data.entity_edges_extracted} entity edges extracted.`
      );
      if (fileRef.current) fileRef.current.value = "";
      fetchDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/documents?id=${id}`, { method: "DELETE" });
      fetchDocuments();
    } catch {
      // Silently handle
    }
  };

  return (
    <div className="space-y-8">
      {/* Upload Section */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="text-xl">📤</span> Upload Document
          </CardTitle>
          <CardDescription>
            Upload a PDF or TXT file. It will be parsed, chunked, embedded, and
            its entity relationships will be extracted automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt"
              className="flex-1 file:mr-3 file:px-3 file:py-1 file:rounded-md file:border-0 file:bg-primary/20 file:text-primary file:text-sm file:font-medium cursor-pointer"
              id="file-upload"
            />
            <Button
              onClick={handleUpload}
              disabled={isUploading}
              className="min-w-[120px] bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              {isUploading ? (
                <span className="flex items-center gap-2">
                  <Spinner /> Ingesting...
                </span>
              ) : (
                "Upload & Ingest"
              )}
            </Button>
          </div>

          {uploadResult && (
            <div className="p-3 rounded-lg bg-[oklch(0.68_0.16_155/0.1)] border border-[oklch(0.68_0.16_155/0.3)] text-sm text-[oklch(0.78_0.12_155)]">
              {uploadResult}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Document List */}
      <Card className="glass-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <span className="text-xl">📚</span> Document Corpus
            </CardTitle>
            <CardDescription>
              {documents.length} document{documents.length !== 1 ? "s" : ""}{" "}
              ingested
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchDocuments}
            disabled={isLoading}
          >
            {isLoading ? <Spinner /> : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-4xl mb-3">📭</p>
              <p className="text-sm">
                No documents yet. Upload your first document above.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-4 rounded-lg bg-secondary/30 border border-border/50 hover:border-primary/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-lg">📄</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {doc.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {doc.source_type} •{" "}
                        {new Date(doc.created_at).toLocaleDateString()}
                        {doc.metadata &&
                          typeof doc.metadata === "object" &&
                          "char_count" in doc.metadata &&
                          ` • ${Math.round(
                            (doc.metadata.char_count as number) / 1000
                          )}K chars`}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(doc.id)}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ==============================================================
// VERIFY VIEW — Submit query + Live Agent Progress + Report
// ==============================================================

function VerifyView() {
  const [query, setQuery] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    if (!query.trim() || isRunning) return;

    setIsRunning(true);
    setEvents([]);
    setReport(null);
    setProgress(0);
    setError(null);

    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Verification failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event: StreamEvent = JSON.parse(line.slice(6));
              setEvents((prev) => [...prev, event]);
              if (event.progress !== undefined) setProgress(event.progress);

              if (
                event.stage === "complete" &&
                event.data &&
                typeof event.data === "object" &&
                "report" in event.data
              ) {
                setReport(
                  (event.data as { report: VerificationReport }).report
                );
              }

              if (event.stage === "error") {
                setError(event.message);
              }
            } catch {
              // Skip malformed events
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Query Input */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="text-xl">🔍</span> Verification Query
          </CardTitle>
          <CardDescription>
            Describe what you want to verify against your document corpus. The
            multi-agent pipeline will decompose, retrieve, cross-check, and
            score risks automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            placeholder={`e.g. "Verify that Vendor X's compliance claims align with their filed documents and identify any contradictions or gaps in their data protection commitments."`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            className="resize-none bg-secondary/30"
            id="verify-query-input"
          />
          <Button
            onClick={handleVerify}
            disabled={isRunning || !query.trim()}
            className="w-full bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20 h-11"
            id="verify-submit-btn"
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <Spinner /> Running Verification Pipeline...
              </span>
            ) : (
              "🚀 Run Verification"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Live Agent Progress */}
      {(isRunning || events.length > 0) && (
        <Card className="glass-card overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className={`text-xl ${isRunning ? "pulse-glow rounded-full" : ""}`}>
                🤖
              </span>{" "}
              Agent Pipeline
              {isRunning && (
                <Badge variant="outline" className="ml-2 border-primary/50 text-primary">
                  Live
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={progress} className="h-2" />
            <ScrollArea className="h-[250px]">
              <div className="space-y-2 pr-4">
                {events.map((event, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 text-sm animate-in fade-in slide-in-from-bottom-2 duration-300"
                  >
                    <StageIcon stage={event.stage} />
                    <span
                      className={
                        event.stage === "error"
                          ? "text-destructive"
                          : event.stage === "complete"
                          ? "text-[oklch(0.68_0.16_155)]"
                          : "text-muted-foreground"
                      }
                    >
                      {event.message}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive">
          <p className="font-medium">Verification failed</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Report */}
      {report && <ReportView report={report} />}
    </div>
  );
}

// ==============================================================
// REPORT VIEW — Rendered verification report
// ==============================================================

function ReportView({ report }: { report: VerificationReport }) {
  return (
    <div className="space-y-6" id="verification-report">
      {/* Risk Score Header */}
      <Card className="glass-card overflow-hidden">
        <div
          className={`h-1 ${
            report.risk_level === "low"
              ? "bg-[oklch(0.68_0.16_155)]"
              : report.risk_level === "medium"
              ? "bg-[oklch(0.78_0.16_70)]"
              : report.risk_level === "high"
              ? "bg-[oklch(0.72_0.18_30)]"
              : "bg-destructive"
          }`}
        />
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">Verification Report</CardTitle>
            <RiskBadge level={report.risk_level} score={report.overall_risk_score} />
          </div>
          <CardDescription className="mt-2">
            {report.summary}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <StatCard
              label="Documents Referenced"
              value={report.total_documents_referenced}
            />
            <StatCard
              label="Chunks Analyzed"
              value={report.total_chunks_analyzed}
            />
            <StatCard label="Claims Verified" value={report.claims.length} />
          </div>
        </CardContent>
      </Card>

      {/* Per-Claim Results */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          📋 Per-Claim Verdicts
        </h3>
        {report.claims.map((claim, i) => (
          <ClaimCard key={claim.sub_question_id || i} claim={claim} index={i} />
        ))}
      </div>
    </div>
  );
}

// ---- Sub-components ----

function ClaimCard({ claim, index }: { claim: ClaimResult; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="glass-card">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-mono">
                #{index + 1}
              </span>
              <VerdictBadge verdict={claim.verdict} />
              {claim.confidence !== undefined && (
                <span className="text-xs text-muted-foreground">
                  {Math.round(claim.confidence * 100)}% confident
                </span>
              )}
            </div>
            <p className="text-sm font-medium">{claim.question}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {claim.reasoning}
            </p>
          </div>
        </div>

        {claim.citations && claim.citations.length > 0 && (
          <>
            <Separator className="my-3" />
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-primary hover:underline"
            >
              {expanded
                ? "Hide citations"
                : `Show ${claim.citations.length} citation${
                    claim.citations.length > 1 ? "s" : ""
                  }`}
            </button>

            {expanded && (
              <div className="mt-3 space-y-2">
                {claim.citations.map((cit, j) => (
                  <div
                    key={j}
                    className="p-3 rounded-md bg-secondary/30 border border-border/50 text-xs"
                  >
                    <p className="font-medium text-primary mb-1">
                      📄 {cit.document_title}
                    </p>
                    <p className="text-muted-foreground italic">
                      &ldquo;{cit.excerpt}&rdquo;
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RiskBadge({
  level,
  score,
}: {
  level: string;
  score: number;
}) {
  const config: Record<string, { bg: string; text: string; ring: string }> = {
    low: {
      bg: "bg-[oklch(0.68_0.16_155/0.15)]",
      text: "text-[oklch(0.78_0.12_155)]",
      ring: "ring-[oklch(0.68_0.16_155/0.3)]",
    },
    medium: {
      bg: "bg-[oklch(0.78_0.16_70/0.15)]",
      text: "text-[oklch(0.82_0.12_70)]",
      ring: "ring-[oklch(0.78_0.16_70/0.3)]",
    },
    high: {
      bg: "bg-[oklch(0.72_0.18_30/0.15)]",
      text: "text-[oklch(0.78_0.14_30)]",
      ring: "ring-[oklch(0.72_0.18_30/0.3)]",
    },
    critical: {
      bg: "bg-destructive/15",
      text: "text-destructive",
      ring: "ring-destructive/30",
    },
  };

  const c = config[level] || config.medium;

  return (
    <div
      className={`px-4 py-2 rounded-xl ${c.bg} ${c.text} ring-1 ${c.ring} flex items-center gap-2`}
    >
      <span className="text-2xl font-bold">{score}</span>
      <div className="text-xs leading-tight">
        <span className="block font-medium uppercase">{level}</span>
        <span className="opacity-70">risk</span>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  switch (verdict) {
    case "supported":
      return (
        <Badge className="bg-[oklch(0.68_0.16_155/0.2)] text-[oklch(0.78_0.12_155)] border-[oklch(0.68_0.16_155/0.3)] hover:bg-[oklch(0.68_0.16_155/0.3)]">
          ✓ Supported
        </Badge>
      );
    case "contradicted":
      return (
        <Badge className="bg-destructive/20 text-destructive border-destructive/30 hover:bg-destructive/30">
          ✗ Contradicted
        </Badge>
      );
    case "unverifiable":
      return (
        <Badge className="bg-[oklch(0.78_0.16_70/0.2)] text-[oklch(0.82_0.12_70)] border-[oklch(0.78_0.16_70/0.3)] hover:bg-[oklch(0.78_0.16_70/0.3)]">
          ? Unverifiable
        </Badge>
      );
    default:
      return <Badge variant="outline">{verdict}</Badge>;
  }
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3 rounded-lg bg-secondary/30">
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function StageIcon({ stage }: { stage: string }) {
  const icons: Record<string, string> = {
    planning: "🧠",
    retrieving: "🔎",
    verifying: "⚖️",
    synthesizing: "📊",
    complete: "✅",
    error: "❌",
  };
  return <span className="text-base shrink-0">{icons[stage] || "⏳"}</span>;
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
