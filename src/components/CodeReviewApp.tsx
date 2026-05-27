"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { jsPDF } from "jspdf";
import { t, setLang, getLang, type Lang } from "@/lib/i18n";

/* ─── types ─── */

type RiskLevel = "high" | "medium" | "low";
type Severity = "critical" | "high" | "medium" | "low";

type Issue = { file?: string; line: number; severity: Severity; message: string };
type Suggestion = { message: string };
type ReviewResult = {
  risk_level: RiskLevel;
  security_issues: Issue[];
  logic_issues: Issue[];
  quality_issues: Issue[];
  suggestions: Suggestion[];
  fixed_code: string;
  summary: string;
  error?: string;
};

type HistoryEntry = {
  id: string;
  timestamp: number;
  input: string;
  inputType: "code" | "repo";
  result: ReviewResult;
};

/* ─── constants ─── */

const HISTORY_KEY = "codereview_history";
const MAX_HISTORY = 20;

/* ─── helpers ─── */

function saveHistory(entry: HistoryEntry) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list: HistoryEntry[] = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {}
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/* ─── pdf generator ─── */

function generatePDF(r: ReviewResult) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 18; // margin
  const CW = W - M * 2; // content width
  let y = M;

  const GRAY = [120, 120, 130] as const;
  const DARK = [30, 30, 40] as const;
  const ACCENT = [99, 102, 241] as const;
  const RED = [239, 68, 68] as const;
  const AMBER = [245, 158, 11] as const;
  const GREEN = [16, 185, 129] as const;

  function checkPage(need: number) {
    if (y + need > 275) {
      doc.addPage();
      y = M;
    }
  }

  function drawLine(yPos: number) {
    doc.setDrawColor(220, 220, 225);
    doc.setLineWidth(0.2);
    doc.line(M, yPos, W - M, yPos);
  }

  function sectionTitle(icon: string, title: string) {
    checkPage(12);
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "bold");
    doc.text(`${icon}  ${title}`, M, y);
    y += 2;
    drawLine(y);
    y += 6;
  }

  // ── header ──
  doc.setFillColor(...ACCENT);
  doc.roundedRect(M, y, CW, 14, 2, 2, "F");
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.text("CodeReview AI — Security Report", M + 6, y + 9.5);

  y += 20;

  // date + risk
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}`, M, y);

  const riskColors: Record<string, readonly [number, number, number]> = { high: RED, medium: AMBER, low: GREEN };
  const riskColor = riskColors[r.risk_level] || GRAY;
  doc.setTextColor(...riskColor);
  doc.setFont("helvetica", "bold");
  doc.text(`Risk Level: ${r.risk_level.toUpperCase()}`, W - M, y, { align: "right" });
  y += 8;

  // ── summary ──
  if (r.summary) {
    sectionTitle("", "EXECUTIVE SUMMARY");
    doc.setFontSize(9.5);
    doc.setTextColor(...DARK);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(r.summary, CW);
    doc.text(lines, M, y);
    y += lines.length * 4.5 + 6;
  }

  // ── stats bar ──
  checkPage(16);
  const boxW = CW / 3;
  const boxes = [
    { label: "Security Issues", count: r.security_issues.length, color: RED },
    { label: "Logic Issues", count: r.logic_issues.length, color: AMBER },
    { label: "Quality Issues", count: r.quality_issues.length, color: GREEN },
  ];
  boxes.forEach((b, i) => {
    const bx = M + i * boxW;
    doc.setFillColor(245, 245, 247);
    doc.roundedRect(bx + (i > 0 ? 1.5 : 0), y, boxW - (i < 2 ? 1.5 : 0), 12, 1.5, 1.5, "F");
    doc.setFontSize(16);
    doc.setTextColor(b.color[0], b.color[1], b.color[2]);
    doc.setFont("helvetica", "bold");
    doc.text(String(b.count), bx + (i > 0 ? 1.5 : 0) + 5, y + 8.5);
    doc.setFontSize(7.5);
    doc.setTextColor(...GRAY);
    doc.setFont("helvetica", "normal");
    doc.text(b.label, bx + (i > 0 ? 1.5 : 0) + 14, y + 8.5);
  });
  y += 18;

  // ── issue list helper ──
  function renderIssues(title: string, issues: Issue[], sevColor: Record<string, readonly [number, number, number]>) {
    if (issues.length === 0) return;
    sectionTitle("", `${title} (${issues.length})`);
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...issues].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));
    sorted.forEach((issue) => {
      checkPage(18);
      const sc = sevColor[issue.severity] || GRAY;
      // severity badge
      doc.setFillColor(sc[0], sc[1], sc[2], 0.1);
      const badgeW = doc.getTextWidth(issue.severity.toUpperCase()) + 4;
      doc.roundedRect(M, y - 3, badgeW, 5, 1, 1, "F");
      doc.setFontSize(7);
      doc.setTextColor(...sc);
      doc.setFont("helvetica", "bold");
      doc.text(issue.severity.toUpperCase(), M + 2, y + 0.5);
      // file:line
      if (issue.file) {
        doc.setTextColor(...ACCENT);
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "normal");
        doc.text(issue.file, M + badgeW + 3, y + 0.5);
      }
      doc.setTextColor(...GRAY);
      doc.setFontSize(7.5);
      doc.text(`Line ${issue.line}`, M + badgeW + (issue.file ? doc.getTextWidth(issue.file) + 6 : 3), y + 0.5);
      y += 6;
      // message
      doc.setTextColor(...DARK);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      const msgLines = doc.splitTextToSize(issue.message, CW - 4);
      doc.text(msgLines, M + 2, y);
      y += msgLines.length * 4 + 4;
    });
  }

  const sevColor: Record<string, readonly [number, number, number]> = {
    critical: RED, high: [234, 88, 12], medium: AMBER, low: GRAY,
  };
  renderIssues("SECURITY ISSUES", r.security_issues, sevColor);
  renderIssues("LOGIC ISSUES", r.logic_issues, sevColor);
  renderIssues("QUALITY ISSUES", r.quality_issues, sevColor);

  // ── suggestions ──
  if (r.suggestions.length > 0) {
    sectionTitle("", `SUGGESTIONS (${r.suggestions.length})`);
    r.suggestions.forEach((s, i) => {
      checkPage(12);
      doc.setFillColor(...ACCENT);
      doc.circle(M + 3, y - 0.5, 2, "F");
      doc.setFontSize(7);
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.text(String(i + 1), M + 3, y + 0.3, { align: "center" });
      doc.setTextColor(...DARK);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      const sl = doc.splitTextToSize(s.message, CW - 10);
      doc.text(sl, M + 8, y);
      y += sl.length * 4 + 4;
    });
  }

  // ── fixed code ──
  if (r.fixed_code) {
    checkPage(20);
    sectionTitle("", "FIXED CODE");
    doc.setFillColor(245, 245, 247);
    doc.roundedRect(M, y - 3, CW, 5, 1, 1, "F");
    doc.setFontSize(7);
    doc.setTextColor(...GRAY);
    doc.text("JavaScript", M + 3, y + 0.5);
    y += 5;

    doc.setFontSize(8);
    doc.setFont("courier", "normal");
    doc.setTextColor(...DARK);
    const codeLines = r.fixed_code.split("\n");
    codeLines.forEach((line) => {
      checkPage(4.5);
      const tl = doc.splitTextToSize(line || " ", CW - 4);
      doc.text(tl, M + 2, y);
      y += tl.length * 4;
    });
  }

  // ── footer ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(...GRAY);
    doc.text(`CodeReview AI — Page ${i}/${pageCount}`, W / 2, 290, { align: "center" });
  }

  doc.save(`code-review-${Date.now()}.pdf`);
}

/* ══════════════════════════════════════════════
   Main App
   ══════════════════════════════════════════════ */

export default function CodeReviewApp() {
  const [repoUrl, setRepoUrl] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"input" | "dashboard" | "history">("input");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [inputLabel, setInputLabel] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const dashboardRef = useRef<HTMLDivElement>(null);

  const hasUrl = repoUrl.trim().length > 0;
  const hasCode = code.trim().length > 0;
  const canSubmit = hasUrl || hasCode;
  const lineCount = code ? code.split("\n").length : 0;

  useEffect(() => { setHistory(loadHistory()); }, []);

  function handleLangSwitch() {
    const next = lang === "en" ? "zh" : "en";
    setLang(next);
    setLangState(next);
  }

  async function handleAnalyze() {
    if (!canSubmit || loading) return;
    setLoading(true);
    setError("");
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const endpoint = hasUrl ? "/api/analyze-repo" : "/api/analyze-code";
    const body = hasUrl ? { repoUrl: repoUrl.trim(), lang } : { code, lang };
    const inputType = hasUrl ? "repo" : "code";
    const label = hasUrl ? repoUrl.trim() : `${lineCount} lines — code snippet`;
    setInputLabel(label);

    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) { const msg = await res.text(); throw new Error(msg || `Request failed (${res.status})`); }
      const data: ReviewResult = await res.json();
      setResult(data);
      setView("dashboard");

      const entry: HistoryEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: Date.now(),
        input: inputType === "repo" ? repoUrl.trim() : code.slice(0, 200),
        inputType,
        result: data,
      };
      saveHistory(entry);
      setHistory(loadHistory());
    } catch (err: any) {
      if (err.name !== "AbortError") setError(err.message || "Something went wrong");
    } finally { setLoading(false); }
  }

  function handleStop() { abortRef.current?.abort(); setLoading(false); }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleExportJSON(r: ReviewResult) {
    const payload = { ...r, exportedAt: new Date().toISOString(), tool: "CodeReview AI" };
    downloadBlob(JSON.stringify(payload, null, 2), `code-review-${Date.now()}.json`, "application/json");
  }

  function handleExportPDF() {
    if (!result) return;
    generatePDF(result);
  }

  function loadFromHistory(entry: HistoryEntry) {
    setResult(entry.result);
    setView("dashboard");
    if (entry.inputType === "repo") { setRepoUrl(entry.input); setCode(""); }
    else { setCode(entry.input); setRepoUrl(""); }
  }

  function handleNewReview() { setResult(null); setError(""); setView("input"); }
  function handleClearHistory() { clearHistory(); setHistory([]); }

  useEffect(() => {
    if (view === "dashboard" && result) {
      dashboardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [view, result]);

  return (
    <div className="relative min-h-screen">
      {/* ─── ambient bg ─── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute inset-0 opacity-[0.015]"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.3) 1px, transparent 0)", backgroundSize: "32px 32px" }} />
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[1000px] h-[700px] bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.06)_0%,transparent_70%)] animate-glow-pulse" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] bg-[radial-gradient(circle,rgba(139,92,246,0.04)_0%,transparent_70%)]" />
      </div>

      <div className="relative z-10">
        {/* ─── nav ─── */}
        <Nav
          view={view}
          hasResult={!!result}
          lang={lang}
          onNew={handleNewReview}
          onHistory={() => setView("history")}
          onExportPDF={handleExportPDF}
          onExportJSON={() => result && handleExportJSON(result)}
          onLangSwitch={handleLangSwitch}
        />

        {/* ─── content ─── */}
        <main className="min-h-[calc(100vh-57px)]">
          {view === "history" ? (
            <HistoryView entries={history} onSelect={loadFromHistory} onClear={handleClearHistory} onNew={handleNewReview} />
          ) : view === "dashboard" && result ? (
            <div ref={dashboardRef}>
              <Dashboard result={result} onCopy={handleCopy} copied={copied} onNew={handleNewReview} inputLabel={inputLabel} />
            </div>
          ) : (
            <InputView
              repoUrl={repoUrl} setRepoUrl={setRepoUrl}
              code={code} setCode={setCode}
              loading={loading} error={error}
              hasUrl={hasUrl} hasCode={hasCode} canSubmit={canSubmit} lineCount={lineCount}
              onAnalyze={handleAnalyze} onStop={handleStop}
            />
          )}
        </main>

        {/* ─── footer ─── */}
        <footer className="border-t border-white/[0.04] py-6 print:hidden">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between text-[11px] text-zinc-600">
            <span>{t("footer.brand")}</span>
            <span>{t("footer.tech")}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   Nav
   ══════════════════════════════════════════════ */

function Nav({ view, hasResult, lang, onNew, onHistory, onExportPDF, onExportJSON, onLangSwitch }: {
  view: string;
  hasResult: boolean;
  lang: Lang;
  onNew: () => void;
  onHistory: () => void;
  onExportPDF: () => void;
  onExportJSON: () => void;
  onLangSwitch: () => void;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.04] glass-strong print:hidden">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <button onClick={onNew} className="flex items-center gap-2.5 group focus-ring rounded-lg -ml-2 px-2 py-1 -my-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/30 transition-shadow">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-zinc-200">CodeReview<span className="text-indigo-400">AI</span></span>
        </button>

        <div className="flex items-center gap-1">
          {/* lang toggle */}
          <button onClick={onLangSwitch}
            className="flex items-center text-[11px] font-semibold px-2 py-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-all border border-white/[0.06] mr-1">
            <span className={cn(lang === "zh" ? "text-indigo-400" : "text-zinc-600")}>中</span>
            <span className="mx-0.5 text-zinc-700">/</span>
            <span className={cn(lang === "en" ? "text-indigo-400" : "text-zinc-600")}>EN</span>
          </button>

          <NavButton onClick={onHistory} active={view === "history"} icon={<path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}>
            {t("nav.history")}
          </NavButton>
          {view === "dashboard" && hasResult && (
            <>
              <NavButton onClick={onExportPDF} icon={<path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />}>
              {t("nav.pdf")}
            </NavButton>
              <NavButton onClick={onExportJSON} icon={<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />}>
              {t("nav.json")}
            </NavButton>
              <div className="w-px h-5 bg-white/[0.06] mx-1" />
            </>
          )}
          {view !== "input" && (
            <button onClick={onNew}
              className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-400 transition-all active:scale-95 shadow-lg shadow-indigo-500/20">
              {t("nav.new")}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function NavButton({ onClick, active, icon, children }: {
  onClick: () => void;
  active?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all",
        active ? "bg-white/[0.06] text-white" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]"
      )}>
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">{icon}</svg>
      <span className="hidden sm:inline">{children}</span>
    </button>
  );
}

/* ══════════════════════════════════════════════
   Input View
   ══════════════════════════════════════════════ */

function InputView({ repoUrl, setRepoUrl, code, setCode, loading, error, hasUrl, hasCode, canSubmit, lineCount, onAnalyze, onStop }: {
  repoUrl: string; setRepoUrl: (v: string) => void;
  code: string; setCode: (v: string) => void;
  loading: boolean; error: string;
  hasUrl: boolean; hasCode: boolean; canSubmit: boolean; lineCount: number;
  onAnalyze: () => void; onStop: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text");
    if (text && text.split("\n").length > 1) {
      // Auto-expand textarea on multi-line paste
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 500) + "px";
        }
      }, 0);
    }
  }

  return (
    <>
      {/* ─── hero ─── */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-16 sm:pt-28 pb-10 animate-fade-up">
        <div className="flex justify-center mb-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] pl-1 pr-3.5 py-1 text-xs">
            <span className="flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 font-medium text-indigo-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 rounded-full bg-indigo-400 animate-ping opacity-75" />
                <span className="relative rounded-full h-1.5 w-1.5 bg-indigo-400" />
              </span>
              New
            </span>
            <span className="text-zinc-500">{t("hero.pill")}</span>
          </div>
        </div>

        <h1 className="text-center text-3xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.08]">
          <span className="text-zinc-100">{t("hero.title1")}</span><br />
          <span className="text-gradient-blue animate-gradient">{t("hero.title2")}</span>
        </h1>

        <p className="mt-5 text-center text-zinc-500 text-sm sm:text-base max-w-lg mx-auto leading-relaxed">
          {t("hero.subtitle")}
        </p>
      </section>

      {/* ─── input area ─── */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 animate-fade-up-delay-1">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* github url */}
          <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden flex flex-col group focus-within:border-indigo-500/30 focus-within:ring-1 focus-within:ring-indigo-500/10 transition-all">
            <div className="flex items-center gap-2.5 px-5 py-3 border-b border-white/[0.04]">
              <svg className="w-4 h-4 text-zinc-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              <span className="text-xs font-medium text-zinc-400">{t("input.repo")}</span>
            </div>
            <div className="p-5 flex-1 flex flex-col">
              <input type="url" placeholder="https://github.com/owner/repo" value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/40 focus:bg-white/[0.04] transition-all font-mono"
                spellCheck={false} />
              <p className="mt-3 text-[11px] text-zinc-600 leading-relaxed flex items-center gap-1.5">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-1.06a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.374" /></svg>
                {t("input.repo.hint")}
              </p>
            </div>
          </div>

          {/* code paste */}
          <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden flex flex-col group focus-within:border-indigo-500/30 focus-within:ring-1 focus-within:ring-indigo-500/10 transition-all">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.04]">
              <div className="flex items-center gap-2.5">
                <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" /></svg>
                <span className="text-xs font-medium text-zinc-400">{t("input.code")}</span>
              </div>
              {hasCode && (
                <span className="text-[11px] text-zinc-600 font-mono tabular-nums bg-white/[0.03] px-2 py-0.5 rounded-md">
                  {lineCount} {t("input.lines")}
                </span>
              )}
            </div>
            <div className="p-5 flex-1 flex flex-col">
              <textarea
                ref={textareaRef}
                rows={8}
                placeholder={"// paste your code here...\n\nfunction example() {\n  return \"hello world\";\n}"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onPaste={handlePaste}
                className="w-full flex-1 min-h-[180px] bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-[13px] font-mono leading-relaxed text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/40 focus:bg-white/[0.04] transition-all resize-y"
                spellCheck={false} />
            </div>
          </div>
        </div>

        {/* ─── action bar ─── */}
        <div className="mt-5 flex items-center justify-between">
          <div className="text-xs text-zinc-600 hidden sm:flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            {hasUrl ? t("input.hint.repo") : hasCode ? `${lineCount} ${t("input.hint.code")}` : t("input.hint.idle")}
          </div>
          <div className="flex items-center gap-3 ml-auto">
            {loading && (
              <button onClick={onStop}
                className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-all">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                {t("input.cancel")}
              </button>
            )}
            <button onClick={onAnalyze} disabled={!canSubmit || loading}
              className={cn(
                "group flex items-center gap-2.5 rounded-xl px-6 py-2.5 text-sm font-semibold transition-all duration-200",
                canSubmit && !loading
                  ? "bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/35 active:scale-[0.97]"
                  : "bg-white/[0.04] text-zinc-600 cursor-not-allowed"
              )}>
              {loading ? (
                <><Spinner size="sm" /> Analyzing...</>
              ) : (
                <><svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg> {t("input.analyze")}</>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* ─── loading ─── */}
      {loading && <LoadingView />}
      {error && <ErrorBanner message={error} />}
    </>
  );
}

/* ══════════════════════════════════════════════
   Loading
   ══════════════════════════════════════════════ */

function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const s = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  return (
    <svg className={`${s} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={3} />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function LoadingView() {
  const [activeStep, setActiveStep] = useState(0);

  const steps = [
    { label: t("loading.step1.label"), desc: t("loading.step1.desc"), icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" },
    { label: t("loading.step2.label"), desc: t("loading.step2.desc"), icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" },
    { label: t("loading.step3.label"), desc: t("loading.step3.desc"), icon: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" },
    { label: t("loading.step4.label"), desc: t("loading.step4.desc"), icon: "M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" },
  ];

  useEffect(() => {
    const timers = steps.map((_, i) =>
      setTimeout(() => setActiveStep(i), i * 1800)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-10 animate-fade-up">
      <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden">
        {/* header */}
        <div className="px-5 py-4 border-b border-white/[0.04] flex items-center gap-3">
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-indigo-400" style={{ animation: `typing-dot 1.4s infinite ${i * 0.2}s` }} />
            ))}
          </div>
          <span className="text-sm font-medium text-zinc-300">{t("loading.title")}</span>
          <span className="ml-auto text-xs text-zinc-600 font-mono tabular-nums">
            {t("loading.step")} {Math.min(activeStep + 1, steps.length)}/{steps.length}
          </span>
        </div>

        {/* progress bar */}
        <div className="h-0.5 bg-white/[0.04] overflow-hidden">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-700 ease-out rounded-full"
            style={{ width: `${((activeStep + 1) / steps.length) * 100}%` }} />
        </div>

        {/* steps */}
        <div className="divide-y divide-white/[0.03]">
          {steps.map((step, i) => {
            const isActive = i === activeStep;
            const isDone = i < activeStep;
            return (
              <div key={i} className={cn(
                "px-5 py-4 flex items-center gap-4 transition-all duration-500",
                isActive && "bg-white/[0.02]",
                isDone && "opacity-50"
              )}>
                <div className={cn(
                  "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300",
                  isActive ? "bg-indigo-500/15 ring-1 ring-indigo-500/30" : isDone ? "bg-emerald-500/10" : "bg-white/[0.04]"
                )}>
                  {isDone ? (
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : (
                    <svg className={cn("w-4 h-4", isActive ? "text-indigo-400" : "text-zinc-600")} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d={step.icon} />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-sm font-medium transition-colors", isActive ? "text-zinc-200" : "text-zinc-500")}>{step.label}</p>
                  <p className="text-[11px] text-zinc-600 mt-0.5">{step.desc}</p>
                </div>
                {isActive && <Spinner size="sm" />}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════
   Error
   ══════════════════════════════════════════════ */

function ErrorBanner({ message }: { message: string }) {
  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 animate-fade-up">
      <div className="rounded-2xl border border-red-500/15 bg-red-500/[0.03] px-5 py-4 flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-red-400">{t("error.title")}</p>
          <p className="text-xs text-red-400/50 mt-1 leading-relaxed">{message}</p>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════
   History View
   ══════════════════════════════════════════════ */

function HistoryView({ entries, onSelect, onClear, onNew }: {
  entries: HistoryEntry[];
  onSelect: (e: HistoryEntry) => void;
  onClear: () => void;
  onNew: () => void;
}) {
  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-10 pb-20">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-xl font-bold text-zinc-100">{t("history.title")}</h2>
          <p className="text-sm text-zinc-600 mt-1">{t("history.subtitle")}</p>
        </div>
        {entries.length > 0 && (
          <button onClick={onClear}
            className="text-xs text-red-400/50 hover:text-red-400 transition-colors flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            {t("history.clear")}
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-[#111118]">
          <div className="flex flex-col items-center justify-center py-20 px-6">
            <div className="relative w-16 h-16 mb-5">
              <div className="absolute inset-0 rounded-2xl bg-indigo-500/10 blur-xl" />
              <div className="relative w-16 h-16 rounded-2xl border border-white/[0.06] bg-[#16161e] flex items-center justify-center">
                <svg className="w-7 h-7 text-zinc-600" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <h3 className="text-sm font-semibold text-zinc-400 mb-1">{t("history.empty")}</h3>
            <p className="text-xs text-zinc-600 text-center max-w-xs mb-6">{t("history.empty.desc")}</p>
            <button onClick={onNew}
              className="text-xs font-medium px-4 py-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-400 transition-all">
              {t("history.start")}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, idx) => {
            const total = entry.result.security_issues.length + entry.result.logic_issues.length + entry.result.quality_issues.length;
            return (
              <button key={entry.id} onClick={() => onSelect(entry)}
                className="w-full text-left rounded-2xl border border-white/[0.06] bg-[#111118] hover:bg-white/[0.02] hover:border-white/[0.1] transition-all px-5 py-4 flex items-center gap-4 group animate-fade-up"
                style={{ animationDelay: `${idx * 0.03}s` }}>
                <RiskDot level={entry.result.risk_level} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-300 truncate">
                      {entry.inputType === "repo" ? entry.input : `${entry.input.slice(0, 60)}...`}
                    </span>
                    <span className="shrink-0 text-[10px] font-medium bg-white/[0.04] text-zinc-600 rounded-md px-1.5 py-0.5 uppercase tracking-wider">
                      {entry.inputType === "repo" ? t("history.repo") : t("history.code")}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="text-[11px] text-zinc-600">{timeAgo(entry.timestamp)}</span>
                    <span className="w-0.5 h-0.5 rounded-full bg-zinc-700" />
                    <span className="text-[11px] text-zinc-600">{total} {t("history.issues")}</span>
                    <span className="w-0.5 h-0.5 rounded-full bg-zinc-700" />
                    <span className={cn(
                      "text-[11px] font-medium",
                      entry.result.risk_level === "high" ? "text-red-400" : entry.result.risk_level === "medium" ? "text-amber-400" : "text-emerald-400"
                    )}>
                      {entry.result.risk_level} {t("history.risk")}
                    </span>
                  </div>
                </div>
                <svg className="w-4 h-4 text-zinc-700 group-hover:text-zinc-500 shrink-0 transition-colors" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RiskDot({ level }: { level: RiskLevel }) {
  const colors: Record<string, string> = {
    high: "bg-red-400 shadow-red-400/30",
    medium: "bg-amber-400 shadow-amber-400/30",
    low: "bg-emerald-400 shadow-emerald-400/30",
  };
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 shadow-sm ${colors[level]}`} />;
}

/* ══════════════════════════════════════════════
   Dashboard
   ══════════════════════════════════════════════ */

function Dashboard({ result, onCopy, copied, onNew, inputLabel }: {
  result: ReviewResult;
  onCopy: (t: string) => void;
  copied: boolean;
  onNew: () => void;
  inputLabel: string;
}) {
  const [activeTab, setActiveTab] = useState<"all" | "security" | "logic" | "quality">("all");
  const totalIssues = result.security_issues.length + result.logic_issues.length + result.quality_issues.length;

  const tabs = [
    { id: "all" as const, label: t("dashboard.tab.all"), count: totalIssues },
    { id: "security" as const, label: t("dashboard.tab.security"), count: result.security_issues.length },
    { id: "logic" as const, label: t("dashboard.tab.logic"), count: result.logic_issues.length },
    { id: "quality" as const, label: t("dashboard.tab.quality"), count: result.quality_issues.length },
  ];

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-20 space-y-5">
      {/* ─── stat cards ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-fade-up">
        <StatCard label={t("dashboard.risk")} value={result.risk_level.toUpperCase()} risk={result.risk_level} icon="shield" />
        <StatCard label={t("dashboard.security")} value={String(result.security_issues.length)} risk={result.security_issues.length > 0 ? "high" : "low"} icon="lock" />
        <StatCard label={t("dashboard.logic")} value={String(result.logic_issues.length)} risk={result.logic_issues.length > 0 ? "medium" : "low"} icon="code" />
        <StatCard label={t("dashboard.quality")} value={String(result.quality_issues.length)} risk={result.quality_issues.length > 0 ? "medium" : "low"} icon="sparkle" />
      </div>

      {/* ─── input context ─── */}
      {inputLabel && (
        <div className="rounded-xl border border-white/[0.04] bg-white/[0.015] px-4 py-2.5 flex items-center gap-2.5 animate-fade-up">
          <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <span className="text-[11px] text-zinc-600">{t("dashboard.analyzed")}:</span>
          <span className="text-[11px] text-zinc-400 font-mono truncate">{inputLabel}</span>
        </div>
      )}

      {/* ─── summary ─── */}
      {result.summary && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden animate-fade-up-delay-1">
          <div className="px-5 py-4 flex items-start gap-3.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0 mt-0.5 ring-1 ring-indigo-500/20">
              <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-1">{t("dashboard.summary.title")}</p>
              <p className="text-sm text-zinc-400 leading-relaxed">{result.summary}</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── issues + sidebar ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 animate-fade-up-delay-2">
        {/* left: issues */}
        <div className="lg:col-span-3 space-y-4">
          {/* tabs */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.02] border border-white/[0.06] print:hidden">
            {tabs.map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-1 justify-center",
                  activeTab === tab.id ? "bg-white/[0.06] text-white shadow-sm" : "text-zinc-600 hover:text-zinc-400"
                )}>
                {tab.label}
                {tab.count > 0 && (
                  <span className={cn(
                    "inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold tabular-nums",
                    activeTab === tab.id ? "bg-indigo-500/20 text-indigo-300" : "bg-white/[0.04] text-zinc-600"
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* issue lists */}
          {(activeTab === "all" || activeTab === "security") && result.security_issues.length > 0 && (
            <IssueAccordion title="Security Issues" icon="shield" issues={result.security_issues} accent="red" />
          )}
          {(activeTab === "all" || activeTab === "logic") && result.logic_issues.length > 0 && (
            <IssueAccordion title="Logic Issues" icon="bug" issues={result.logic_issues} accent="amber" />
          )}
          {(activeTab === "all" || activeTab === "quality") && result.quality_issues.length > 0 && (
            <IssueAccordion title="Quality Issues" icon="code" issues={result.quality_issues} accent="slate" />
          )}

          {activeTab !== "all" && tabs.find((t) => t.id === activeTab)?.count === 0 && (
            <div className="rounded-2xl border border-white/[0.06] bg-[#111118] px-5 py-14 text-center">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-sm text-zinc-400 font-medium">{t("dashboard.no.issues").replace("{type}", activeTab)}</p>
              <p className="text-xs text-zinc-600 mt-1">{t("dashboard.no.issues.desc")}</p>
            </div>
          )}

          {totalIssues === 0 && activeTab === "all" && (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.03] px-5 py-14 text-center">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-3 ring-1 ring-emerald-500/20">
                <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-sm text-emerald-400 font-semibold">{t("dashboard.clean.title")}</p>
              <p className="text-xs text-zinc-600 mt-1">{t("dashboard.clean.desc")}</p>
            </div>
          )}
        </div>

        {/* right: sidebar */}
        <div className="lg:col-span-2 space-y-4">
          <SuggestionsPanel suggestions={result.suggestions} />
          <FixedCodePanel code={result.fixed_code} onCopy={onCopy} copied={copied} />
        </div>
      </div>
    </section>
  );
}

/* ─── stat card ─── */

function StatCard({ label, value, risk, icon }: { label: string; value: string; risk: RiskLevel; icon: string }) {
  const riskColors: Record<RiskLevel, { bg: string; text: string; dot: string; ring: string }> = {
    high: { bg: "bg-red-500/8", text: "text-red-400", dot: "bg-red-400", ring: "ring-red-500/15" },
    medium: { bg: "bg-amber-500/8", text: "text-amber-400", dot: "bg-amber-400", ring: "ring-amber-500/15" },
    low: { bg: "bg-emerald-500/8", text: "text-emerald-400", dot: "bg-emerald-400", ring: "ring-emerald-500/15" },
  };
  const c = riskColors[risk];
  const iconPath: Record<string, React.ReactNode> = {
    shield: <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />,
    lock: <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />,
    code: <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />,
    sparkle: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />,
  };

  return (
    <div className={cn(
      "rounded-2xl border border-white/[0.06] bg-[#111118] p-4 ring-1 ring-inset transition-all hover:border-white/[0.1]",
      c.ring
    )}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-semibold">{label}</p>
        <svg className={cn("w-4 h-4", c.text, "opacity-50")} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          {iconPath[icon]}
        </svg>
      </div>
      <div className="flex items-center gap-2">
        <span className={cn("w-2 h-2 rounded-full shadow-sm", c.dot, risk === "high" ? "shadow-red-400/30" : risk === "medium" ? "shadow-amber-400/30" : "shadow-emerald-400/30")} />
        <span className={cn("text-xl font-bold tabular-nums", c.text)}>{value}</span>
      </div>
    </div>
  );
}

/* ─── issue accordion ─── */

function IssueAccordion({ title, icon, issues, accent }: {
  title: string; icon: "shield" | "bug" | "code"; issues: Issue[]; accent: "red" | "amber" | "slate";
}) {
  const [expanded, setExpanded] = useState(true);

  const ACCENT_CFG: Record<"red" | "amber" | "slate", { ring: string; iconBg: string; iconText: string; badge: string }> = {
    red: { ring: "ring-red-500/10", iconBg: "bg-red-500/10", iconText: "text-red-400", badge: "bg-red-500/10 text-red-400" },
    amber: { ring: "ring-amber-500/10", iconBg: "bg-amber-500/10", iconText: "text-amber-400", badge: "bg-amber-500/10 text-amber-400" },
    slate: { ring: "ring-zinc-500/10", iconBg: "bg-zinc-500/10", iconText: "text-zinc-400", badge: "bg-zinc-500/10 text-zinc-400" },
  };
  const cfg = ACCENT_CFG[accent];

  const icons: Record<string, React.ReactNode> = {
    shield: <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />,
    bug: <path strokeLinecap="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0112 12.75z" />,
    code: <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />,
  };
  const iconPath = icons[icon]!;

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...issues].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return (
    <div className={cn("rounded-2xl border border-white/[0.06] bg-[#111118] ring-1 ring-inset overflow-hidden", cfg.ring)}>
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-white/[0.02] transition-colors">
        <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center", cfg.iconBg)}>
          <svg className={cn("w-3.5 h-3.5", cfg.iconText)} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            {iconPath}
          </svg>
        </div>
        <span className="text-sm font-semibold text-zinc-300">{title}</span>
        <span className={cn("ml-1 text-[10px] font-bold rounded-md px-1.5 py-0.5 tabular-nums", cfg.badge)}>{issues.length}</span>
        <svg className={cn("w-3.5 h-3.5 text-zinc-600 ml-auto transition-transform duration-200", expanded && "rotate-180")}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {expanded && (
        <ul className="border-t border-white/[0.04] divide-y divide-white/[0.03]">
          {sorted.map((issue, i) => <IssueRow key={i} issue={issue} />)}
        </ul>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-3 hover:bg-white/[0.02] transition-colors">
        <div className="flex items-start gap-3">
          <SeverityPill severity={issue.severity} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {issue.file && <span className="text-[11px] font-mono text-indigo-400/60 truncate max-w-[160px]">{issue.file}</span>}
              <span className="text-[10px] font-mono text-zinc-700 bg-white/[0.03] px-1.5 py-0.5 rounded">L{issue.line}</span>
            </div>
            <p className="text-[13px] text-zinc-400 mt-1 leading-relaxed">{issue.message}</p>
          </div>
          <svg className={cn("w-3 h-3 text-zinc-700 shrink-0 mt-1.5 transition-transform duration-150", open && "rotate-180")}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-3 animate-fade-in">
          <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] px-4 py-3">
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div><span className="text-zinc-600">Severity</span><p className="text-zinc-400 font-medium capitalize mt-0.5">{issue.severity}</p></div>
              <div><span className="text-zinc-600">Line</span><p className="text-zinc-400 font-mono mt-0.5">{issue.line}</p></div>
              {issue.file && <div className="col-span-2"><span className="text-zinc-600">File</span><p className="text-zinc-400 font-mono mt-0.5 truncate">{issue.file}</p></div>}
              <div className="col-span-2 mt-1"><span className="text-zinc-600">Details</span><p className="text-zinc-400 mt-0.5 leading-relaxed">{issue.message}</p></div>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/* ─── suggestions panel ─── */

function SuggestionsPanel({ suggestions }: { suggestions: Suggestion[] }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.04]">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center">
          <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-zinc-300">{t("dashboard.suggestions")}</span>
        <span className="ml-auto text-[10px] font-bold bg-indigo-500/10 text-indigo-400 rounded-md px-1.5 py-0.5 tabular-nums">{suggestions.length}</span>
      </div>
      <ul className="divide-y divide-white/[0.03]">
        {suggestions.map((s, i) => (
          <li key={i} className="flex gap-3 px-4 py-3.5">
            <span className="mt-0.5 w-5 h-5 rounded-md bg-white/[0.04] flex items-center justify-center shrink-0">
              <span className="text-[10px] font-bold text-zinc-600">{i + 1}</span>
            </span>
            <span className="text-[13px] text-zinc-400 leading-relaxed">{s.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── fixed code panel ─── */

function FixedCodePanel({ code, onCopy, copied }: { code: string; onCopy: (t: string) => void; copied: boolean }) {
  if (!code) return null;
  const lines = code.split("\n");

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111118] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-zinc-300">{t("dashboard.fixed.code")}</span>
        </div>
        <button onClick={() => onCopy(code)}
          className={cn(
            "flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all",
            copied ? "bg-emerald-500/10 text-emerald-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
          )}>
          {copied ? (
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>{t("dashboard.copied")}</>
          ) : (
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>{t("dashboard.copy")}</>
          )}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] font-mono">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                <td className="pl-4 pr-3 py-0 text-right select-none text-zinc-800 w-[1%] whitespace-nowrap align-top leading-[1.7]">{i + 1}</td>
                <td className="pr-4 pl-3 py-0 align-top leading-[1.7]"><SyntaxLine code={line} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── syntax highlighter ─── */

function SyntaxLine({ code }: { code: string }) {
  const highlighted = useMemo(() => highlightLine(code), [code]);
  return <span dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

function highlightLine(code: string): string {
  if (!code.trim()) return "&nbsp;";
  let html = escapeHtml(code);
  html = html.replace(/(\/\/.*$|#.*$)/m, '<span style="color:#52535e;font-style:italic">$1</span>');
  html = html.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span style="color:#6ee7b7">$1</span>');
  html = html.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|typeof|instanceof|def|self|True|False|None|public|private|static|void|boolean|int|String)\b/g, '<span style="color:#a78bfa">$1</span>');
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#fbbf24">$1</span>');
  html = html.replace(/([{}[\]()])/g, '<span style="color:#52535e">$1</span>');
  return html;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/* ─── severity pill ─── */

function SeverityPill({ severity }: { severity: string }) {
  const s = severity.toLowerCase();
  const styles: Record<string, string> = {
    critical: "bg-red-500/15 text-red-300 ring-red-500/25",
    high: "bg-orange-500/15 text-orange-300 ring-orange-500/25",
    medium: "bg-amber-500/15 text-amber-300 ring-amber-500/25",
    low: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/20",
  };
  return (
    <span className={cn(
      "shrink-0 mt-0.5 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset",
      styles[s] || styles.low
    )}>
      {s}
    </span>
  );
}
