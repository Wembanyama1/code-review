export type RiskLevel = "high" | "medium" | "low";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Issue {
  file?: string;
  line: number;
  severity: Severity;
  message: string;
}

export interface Suggestion {
  message: string;
}

export interface ReviewResult {
  risk_level: RiskLevel;
  security_issues: Issue[];
  logic_issues: Issue[];
  quality_issues: Issue[];
  suggestions: Suggestion[];
  fixed_code: string;
  summary: string;
}

export const EMPTY_RESULT: ReviewResult = {
  risk_level: "low",
  security_issues: [],
  logic_issues: [],
  quality_issues: [],
  suggestions: [],
  fixed_code: "",
  summary: "",
};
