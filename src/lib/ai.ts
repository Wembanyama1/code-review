import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompts";
import { ReviewResult, EMPTY_RESULT } from "./types";
import type { Lang } from "./i18n";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }
  return _client;
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const MAX_CODE_CHARS = 60_000;
const TIMEOUT_MS = 120_000;

export async function analyzeWithAI(userPrompt: string, lang: Lang = "en"): Promise<ReviewResult> {
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_AUTH_TOKEN is not configured");
  }

  const client = getClient();

  const truncated =
    userPrompt.length > MAX_CODE_CHARS
      ? userPrompt.slice(0, MAX_CODE_CHARS) +
        "\n\n// ... [truncated — code exceeds analysis limit]"
      : userPrompt;

  const langRule = lang === "zh"
    ? "\n\nIMPORTANT: Write ALL human-readable text (summary, suggestions, issue messages) in Chinese (简体中文). The JSON keys and fixed_code must remain in English."
    : "";

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT + "\n\nRespond with ONLY a JSON object. No markdown fences, no explanation before or after." + langRule,
      messages: [{ role: "user", content: truncated }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") {
      throw new Error("Empty response from AI model");
    }

    return parseResponse(block.text);
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("AI analysis timed out — code may be too large");
    }
    if (err.status === 429) {
      throw new Error("Rate limit exceeded. Please try again shortly.");
    }
    if (err.status === 401) {
      throw new Error("Invalid ANTHROPIC_AUTH_TOKEN");
    }
    throw err;
  }
}

/* ─── response parser ─── */

function parseResponse(raw: string): ReviewResult {
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    console.error("[ai] Could not extract JSON from response:", raw.slice(0, 500));
    throw new Error("Failed to parse AI response as JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e: any) {
    console.error("[ai] JSON.parse failed:", e.message);
    console.error("[ai] Attempted string:", jsonStr.slice(0, 500));
    throw new Error(`Invalid JSON from AI: ${e.message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AI response is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  return {
    risk_level: validateRiskLevel(obj.risk_level),
    security_issues: validateIssues(obj.security_issues),
    logic_issues: validateIssues(obj.logic_issues),
    quality_issues: validateIssues(obj.quality_issues),
    suggestions: validateSuggestions(obj.suggestions),
    fixed_code: typeof obj.fixed_code === "string" ? obj.fixed_code : "",
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

function extractJson(raw: string): string | null {
  const text = raw.trim();

  // 1. strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // 2. try direct parse
  if (text.startsWith("{")) {
    // try direct parse first
    try { JSON.parse(text); return text; } catch {}
    // if it fails, the JSON might be truncated — try to repair
    return repairTruncatedJson(text);
  }

  // 3. find first { to last }
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;
  const slice = text.slice(firstBrace);

  // try parsing as-is
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { JSON.parse(candidate); return candidate; } catch {}
  }

  // try repairing truncated JSON
  return repairTruncatedJson(slice);
}

function repairTruncatedJson(text: string): string {
  let s = text;

  // if inside a string (odd number of unescaped quotes), close it
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (s[i] === "\\") { escaped = true; continue; }
    if (s[i] === '"') inString = !inString;
  }
  if (inString) s += '"';

  // count open braces/brackets and close them
  let depth = 0;
  let arrDepth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    else if (ch === "[") arrDepth++;
    else if (ch === "]" && arrDepth > 0) arrDepth--;
  }
  // close trailing commas before adding closing brackets
  s = s.replace(/,\s*$/, "");
  for (let i = 0; i < arrDepth; i++) s += "]";
  for (let i = 0; i < depth; i++) s += "}";

  return s;
}

/* ─── validators ─── */

function validateRiskLevel(val: unknown): ReviewResult["risk_level"] {
  if (val === "high" || val === "medium" || val === "low") return val;
  return "low";
}

function validateSeverity(val: unknown): "critical" | "high" | "medium" | "low" {
  if (val === "critical" || val === "high" || val === "medium" || val === "low") return val;
  return "low";
}

function validateIssues(val: unknown): ReviewResult["security_issues"] {
  if (!Array.isArray(val)) return [];
  return val
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null
    )
    .map((item) => ({
      line: typeof item.line === "number" ? item.line : 0,
      severity: validateSeverity(item.severity),
      message: typeof item.message === "string" ? item.message : "",
      ...(typeof item.file === "string" ? { file: item.file } : {}),
    }))
    .filter((i) => i.message.length > 0);
}

function validateSuggestions(val: unknown): ReviewResult["suggestions"] {
  if (!Array.isArray(val)) return [];
  return val
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null
    )
    .map((item) => ({
      message: typeof item.message === "string" ? item.message : "",
    }))
    .filter((s) => s.message.length > 0);
}
