import type { AppConfig } from "../../config/env.js";
import { ProviderError } from "../../shared/errors.js";

export interface WebResult {
  id: string; // W1, W2, ...
  title: string;
  url: string;
  snippet: string;
  retrievedAt: string;
  provider: string;
}
export interface WebSearchProvider {
  readonly id: string;
  search(query: string, opts: { count: number; timeoutMs: number }): Promise<WebResult[]>;
}
export interface WebEvidence {
  status: "unavailable" | "ok" | "error" | "skipped";
  provider: string;
  reason?: string;
  results: WebResult[];
}

class BraveProvider implements WebSearchProvider {
  readonly id = "brave";
  constructor(private apiKey: string, private baseUrl: string) {}
  async search(query: string, { count, timeoutMs }: { count: number; timeoutMs: number }): Promise<WebResult[]> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/res/v1/web/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": this.apiKey }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new ProviderError("brave", (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (err as Error).message, err);
    }
    if (!res.ok) throw new ProviderError("brave", `HTTP ${res.status}`);
    const json: any = await res.json();
    const retrievedAt = new Date().toISOString();
    const items: any[] = json?.web?.results ?? [];
    return items.slice(0, count).map((r, i) => ({
      id: `W${i + 1}`,
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.description ?? "").replace(/<[^>]+>/g, ""),
      retrievedAt,
      provider: "brave",
    }));
  }
}

class TavilyProvider implements WebSearchProvider {
  readonly id = "tavily";
  constructor(private apiKey: string, private baseUrl: string) {}
  async search(query: string, { count, timeoutMs }: { count: number; timeoutMs: number }): Promise<WebResult[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/search`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey, query, max_results: count, search_depth: "basic", include_answer: false, include_raw_content: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ProviderError("tavily", (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (err as Error).message, err);
    }
    if (!res.ok) throw new ProviderError("tavily", `HTTP ${res.status}`);
    const json: any = await res.json();
    const retrievedAt = new Date().toISOString();
    const items: any[] = json?.results ?? [];
    return items.slice(0, count).map((r, i) => ({
      id: `W${i + 1}`,
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.content ?? "").replace(/<[^>]+>/g, ""),
      retrievedAt,
      provider: "tavily",
    }));
  }
}

export function createWebSearchProvider(cfg: AppConfig): WebSearchProvider | null {
  if (cfg.WEB_SEARCH_PROVIDER === "none") return null;
  if (cfg.WEB_SEARCH_PROVIDER === "tavily")
    return new TavilyProvider(cfg.WEB_SEARCH_API_KEY!, cfg.WEB_SEARCH_BASE_URL ?? "https://api.tavily.com");
  return new BraveProvider(cfg.WEB_SEARCH_API_KEY!, cfg.WEB_SEARCH_BASE_URL ?? "https://api.search.brave.com");
}

/** Never throws: provider failures become a disclosed `error` status and the other channels carry on. */
export async function fetchWebEvidence(p: WebSearchProvider | null, query: string, timeoutMs: number): Promise<WebEvidence> {
  if (!p) return { status: "unavailable", provider: "none", reason: "No web-search provider configured (WEB_SEARCH_PROVIDER=none). No web evidence is included.", results: [] };
  try {
    const results = await p.search(query, { count: 5, timeoutMs });
    return { status: "ok", provider: p.id, results };
  } catch (err) {
    return { status: "error", provider: p.id, reason: (err as Error).message, results: [] };
  }
}
