/* Hive IDE — demo data. Plain script; attaches window.HIVE.
   File contents are stored as arrays of lines (joined with \n) to avoid
   template-literal escaping pain with backticks/${} inside the code samples. */
window.HIVE = (function () {
  const L = (...lines) => lines.join("\n");

  /* ----------------------------- ROLES ----------------------------- */
  const ROLE = {
    manager:      { key: "manager",      label: "Manager",      abbr: "MG", color: "#F59E0B", model: "orchestrator" },
    techlead:     { key: "techlead",     label: "Tech Lead",    abbr: "TL", color: "#8B5CF6", model: "Claude Opus" },
    senior:       { key: "senior",       label: "Senior",       abbr: "SR", color: "#3B82F6", model: "Claude Sonnet" },
    intermediate: { key: "intermediate", label: "Intermediate", abbr: "IM", color: "#6366F1", model: "Claude Haiku" },
    junior:       { key: "junior",       label: "Junior",       abbr: "JR", color: "#22D3EE", model: "GPT-4o-mini" },
    qa:           { key: "qa",           label: "QA",           abbr: "QA", color: "#10B981", model: "Claude Sonnet" },
  };

  /* ----------------------- FILE CONTENTS --------------------------- */
  const C = {};

  C["src/components/AuthForm.tsx"] = L(
    "import { useState } from 'react';",
    "import { useAuth } from '../hooks/useAuth';",
    "import { Button } from './Button';",
    "import type { Provider } from '../lib/oauth';",
    "",
    "interface AuthFormProps {",
    "  providers: Provider[];",
    "  onSuccess: (token: string) => void;",
    "}",
    "",
    "// Sign-in card shown on the marketing site and the app shell.",
    "export function AuthForm({ providers, onSuccess }: AuthFormProps) {",
    "  const { signIn, loading, error } = useAuth();",
    "  const [email, setEmail] = useState('');",
    "",
    "  async function handleProvider(p: Provider) {",
    "    const token = await signIn(p.id);",
    "    if (token) onSuccess(token);",
    "  }",
    "",
    "  return (",
    "    <div className=\"auth-card\">",
    "      <h1>Welcome back</h1>",
    "      <p>Sign in to continue to your dashboard.</p>",
    "",
    "      {providers.map((p) => (",
    "        <Button key={p.id} variant=\"provider\" onClick={() => handleProvider(p)}>",
    "          Continue with {p.label}",
    "        </Button>",
    "      ))}",
    "",
    "      {error && <span className=\"field-error\">{error}</span>}",
    "    </div>",
    "  );",
    "}"
  );

  C["src/lib/oauth.ts"] = L(
    "import { discovery } from './discovery';",
    "",
    "export interface Provider {",
    "  id: 'google' | 'github';",
    "  label: string;",
    "  scopes: string[];",
    "}",
    "",
    "export const providers: Provider[] = [",
    "  { id: 'google', label: 'Google', scopes: ['openid', 'email', 'profile'] },",
    "  { id: 'github', label: 'GitHub', scopes: ['read:user', 'user:email'] },",
    "];",
    "",
    "// exchangeCode trades an authorization code for a verified identity",
    "// using the provider's OpenID Connect discovery document.",
    "export async function exchangeCode(provider: Provider, code: string) {",
    "  const cfg = await discovery(provider.id);",
    "  const res = await fetch(cfg.token_endpoint, {",
    "    method: 'POST',",
    "    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },",
    "    body: new URLSearchParams({ code, grant_type: 'authorization_code' }),",
    "  });",
    "  return res.json();",
    "}"
  );

  C["src/hooks/useAuth.ts"] = L(
    "import { useState, useCallback } from 'react';",
    "import { exchangeCode, providers } from '../lib/oauth';",
    "",
    "export function useAuth() {",
    "  const [loading, setLoading] = useState(false);",
    "  const [error, setError] = useState<string | null>(null);",
    "",
    "  const signIn = useCallback(async (id: string) => {",
    "    setLoading(true);",
    "    setError(null);",
    "    try {",
    "      const provider = providers.find((p) => p.id === id)!;",
    "      const { access_token } = await exchangeCode(provider, '');",
    "      return access_token as string;",
    "    } catch (e) {",
    "      setError('Could not sign in. Please try again.');",
    "      return null;",
    "    } finally {",
    "      setLoading(false);",
    "    }",
    "  }, []);",
    "",
    "  return { signIn, loading, error };",
    "}"
  );

  C["src/components/Button.tsx"] = L(
    "import type { ReactNode } from 'react';",
    "",
    "type Variant = 'primary' | 'ghost' | 'provider';",
    "",
    "interface ButtonProps {",
    "  variant?: Variant;",
    "  onClick?: () => void;",
    "  children: ReactNode;",
    "}",
    "",
    "export function Button({ variant = 'primary', onClick, children }: ButtonProps) {",
    "  return (",
    "    <button className={`btn btn-${variant}`} onClick={onClick}>",
    "      {children}",
    "    </button>",
    "  );",
    "}"
  );

  C["src/lib/api.ts"] = L(
    "const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';",
    "",
    "export async function api<T>(path: string, init?: RequestInit): Promise<T> {",
    "  const res = await fetch(`${BASE_URL}${path}`, {",
    "    ...init,",
    "    headers: { 'Content-Type': 'application/json', ...init?.headers },",
    "  });",
    "  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);",
    "  return res.json() as Promise<T>;",
    "}"
  );

  C["src/App.tsx"] = L(
    "import { AuthForm } from './components/AuthForm';",
    "import { providers } from './lib/oauth';",
    "import './styles/theme.css';",
    "",
    "export default function App() {",
    "  return (",
    "    <main className=\"shell\">",
    "      <AuthForm",
    "        providers={providers}",
    "        onSuccess={(token) => console.log('signed in', token)}",
    "      />",
    "    </main>",
    "  );",
    "}"
  );

  C["src/styles/theme.css"] = L(
    ":root {",
    "  --brand: #6366f1;",
    "  --bg: #0f172a;",
    "  --fg: #f1f5f9;",
    "  --radius: 8px;",
    "}",
    "",
    ".auth-card {",
    "  max-width: 360px;",
    "  padding: 32px;",
    "  border-radius: var(--radius);",
    "  background: var(--bg);",
    "  color: var(--fg);",
    "}",
    "",
    ".btn-provider {",
    "  width: 100%;",
    "  margin-top: 12px;",
    "}"
  );

  C["package.json"] = L(
    "{",
    "  \"name\": \"web-dashboard\",",
    "  \"private\": true,",
    "  \"version\": \"2.4.1\",",
    "  \"type\": \"module\",",
    "  \"scripts\": {",
    "    \"dev\": \"vite\",",
    "    \"build\": \"tsc && vite build\",",
    "    \"test\": \"vitest run\"",
    "  },",
    "  \"dependencies\": {",
    "    \"react\": \"^18.3.1\",",
    "    \"react-dom\": \"^18.3.1\"",
    "  }",
    "}"
  );

  C["README.md"] = L(
    "# web-dashboard",
    "",
    "The acme customer dashboard. Built with Vite + React + TypeScript.",
    "",
    "## Getting started",
    "",
    "```bash",
    "pnpm install",
    "pnpm dev",
    "```",
    "",
    "## Auth",
    "",
    "OAuth2 is being migrated to support **Google** and **GitHub** providers.",
    "Tracked in requirement `REQ-001`.",
    "",
    "- Provider config lives in `src/lib/oauth.ts`",
    "- The sign-in UI is `src/components/AuthForm.tsx`"
  );

  /* ----- the file an agent is actively writing (streamed in editor) ----- */
  const AGENT_FILE = "src/lib/oauth.ts";
  // The "incoming" version the agent is typing toward (a few extra lines).
  C["__oauth_incoming"] = C["src/lib/oauth.ts"] + "\n" + L(
    "",
    "// refreshToken rotates a refresh token and returns the new pair.",
    "export async function refreshToken(provider: Provider, token: string) {",
    "  const cfg = await discovery(provider.id);",
    "  const res = await fetch(cfg.token_endpoint, {",
    "    method: 'POST',",
    "    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),",
    "  });",
    "  return res.json();",
    "}"
  );

  /* --------------------------- FILE TREE --------------------------- */
  // git: 'M' modified, 'A' added, 'U' untracked. agent: role key if being written.
  const tree = [
    { type: "folder", name: "src", open: true, children: [
      { type: "folder", name: "components", open: true, children: [
        { type: "file", name: "AuthForm.tsx", path: "src/components/AuthForm.tsx", lang: "tsx", git: "M" },
        { type: "file", name: "Button.tsx", path: "src/components/Button.tsx", lang: "tsx" },
      ]},
      { type: "folder", name: "hooks", open: true, children: [
        { type: "file", name: "useAuth.ts", path: "src/hooks/useAuth.ts", lang: "ts", git: "M" },
      ]},
      { type: "folder", name: "lib", open: true, children: [
        { type: "file", name: "oauth.ts", path: "src/lib/oauth.ts", lang: "ts", git: "M", agent: "intermediate" },
        { type: "file", name: "api.ts", path: "src/lib/api.ts", lang: "ts" },
        { type: "file", name: "discovery.ts", path: "src/lib/discovery.ts", lang: "ts", git: "A" },
      ]},
      { type: "folder", name: "styles", children: [
        { type: "file", name: "theme.css", path: "src/styles/theme.css", lang: "css" },
      ]},
      { type: "file", name: "App.tsx", path: "src/App.tsx", lang: "tsx" },
    ]},
    { type: "folder", name: "public", children: [
      { type: "file", name: "favicon.svg", path: "public/favicon.svg", lang: "xml" },
    ]},
    { type: "file", name: "package.json", path: "package.json", lang: "json", git: "M" },
    { type: "file", name: "tsconfig.json", path: "tsconfig.json", lang: "json" },
    { type: "file", name: "vite.config.ts", path: "vite.config.ts", lang: "ts" },
    { type: "file", name: "README.md", path: "README.md", lang: "md" },
  ];

  /* --------------------------- PROJECTS ---------------------------- */
  const projects = [
    { id: "web-dashboard", name: "acme/web-dashboard", stack: "TypeScript · React", branch: "feat/oauth2", agents: 3, runs: 1, status: "running", current: true,
      req: "REQ-001 · OAuth2 with Google & GitHub" },
    { id: "payments-api", name: "acme/payments-api", stack: "Go", branch: "main", agents: 4, runs: 1, status: "running",
      req: "REQ-014 · Idempotency keys on charge endpoint" },
    { id: "billing", name: "acme/billing", stack: "Go · Postgres", branch: "main", agents: 2, runs: 1, status: "review",
      req: "REQ-002 · Event-sourced ledger migration" },
    { id: "mobile-app", name: "acme/mobile-app", stack: "React Native", branch: "main", agents: 0, runs: 0, status: "idle",
      req: "No active runs" },
    { id: "web-dashboard-old", name: "acme/admin-console", stack: "TypeScript · Vue", branch: "main", agents: 2, runs: 1, status: "blocked",
      req: "REQ-009 · RBAC for org settings" },
  ];

  /* ------------------------- ORCHESTRATION ------------------------- */
  // Story board for the open project's active requirement.
  const board = {
    pending: [
      { id: "STORY-007", title: "Rate-limit the token endpoint", pts: 3, role: "junior", status: "pending" },
    ],
    running: [
      { id: "STORY-002", title: "Implement Google OAuth flow", pts: 5, role: "intermediate", status: "running", file: "src/lib/oauth.ts" },
      { id: "STORY-003", title: "GitHub provider + scopes", pts: 5, role: "junior", status: "running" },
    ],
    review: [
      { id: "STORY-005", title: "Session cookie + refresh rotation", pts: 6, role: "senior", status: "review" },
    ],
    done: [
      { id: "STORY-001", title: "OAuth2 provider config scaffold", pts: 3, role: "junior", status: "done" },
      { id: "STORY-004", title: "useAuth hook + error states", pts: 4, role: "intermediate", status: "done" },
      { id: "STORY-006", title: "Provider discovery + cache", pts: 5, role: "senior", status: "done" },
    ],
  };

  // The active run's roster (agents working the open project).
  const roster = [
    { role: "manager", name: "Manager", status: "running", note: "draining inbox · tick 184" },
    { role: "techlead", name: "Tech Lead", status: "done", note: "decomposed 7 stories" },
    { role: "senior", name: "Senior", status: "review", note: "reviewing STORY-005" },
    { role: "intermediate", name: "Intermediate", status: "running", note: "writing oauth.ts", file: "src/lib/oauth.ts" },
    { role: "junior", name: "Junior", status: "running", note: "STORY-003 · github.ts" },
    { role: "qa", name: "QA", status: "pending", note: "queued · waiting on STORY-002" },
  ];

  // Manager log lines (bottom panel + dock). cls maps to a color class.
  const log = [
    { t: "00:00", cls: "dim", txt: "manager tick 184 — draining inbox (2 messages)" },
    { t: "00:01", cls: "", txt: "spawned Intermediate → STORY-002 (worktree agent/web--im-7c3a)" },
    { t: "00:04", cls: "", txt: "Intermediate: editing src/lib/oauth.ts" },
    { t: "00:09", cls: "ok", txt: "✓ Junior committed src/lib/discovery.ts → STORY-006" },
    { t: "00:12", cls: "", txt: "Senior requested changes on STORY-005 (refresh rotation)" },
    { t: "00:18", cls: "pr", txt: "opened PR #218 — feat(auth): OAuth2 provider config" },
    { t: "00:24", cls: "ok", txt: "✓ QA passed lint + types on STORY-006" },
  ];

  // Inline chat with the orchestrator.
  const chat = [
    { who: "you", txt: "Make sure refresh tokens rotate on every use." },
    { who: "manager", role: "manager", txt: "Noted. That's STORY-005 (Senior). I've re-pended it with an acceptance note: rotate on use, revoke the old token." },
    { who: "manager", role: "manager", txt: "Intermediate is wiring the Google flow in src/lib/oauth.ts now — you'll see it land in the editor live." },
  ];

  // Open editor tabs (paths). Active editable file + the agent file.
  const openTabs = [
    "src/components/AuthForm.tsx",
    "src/lib/oauth.ts",
    "src/hooks/useAuth.ts",
    "README.md",
  ];

  // Problems panel
  const problems = [
    { sev: "warn", file: "src/hooks/useAuth.ts", line: 18, msg: "'loading' is declared but never read in this scope." },
    { sev: "info", file: "src/lib/oauth.ts", line: 27, msg: "Agent edit in progress — types will re-check on save." },
  ];

  const prs = [
    { num: 218, title: "feat(auth): OAuth2 provider config + Google flow", role: "intermediate", branch: "agent/web--im-7c3a", status: "review", add: 137, del: 18, checks: "running", time: "12m ago" },
    { num: 217, title: "feat(auth): useAuth hook + provider discovery", role: "senior", branch: "agent/web--sr-2f10", status: "merged", add: 98, del: 22, checks: "passed", time: "1h ago" },
  ];

  return { ROLE, C, AGENT_FILE, tree, projects, board, roster, log, chat, openTabs, problems, prs };
})();
