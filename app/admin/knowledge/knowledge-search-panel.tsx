"use client";

import { useMemo, useState } from "react";
import type { GrantKnowledgeSearchResponse } from "@/lib/knowledge/search";
import { MetricHelp } from "../metric-help";

type KnowledgeSearchPanelProps = {
  canComposeAi: boolean;
  canIndex: boolean;
  canUseSemantic: boolean;
  initialAiConfigured: boolean;
  initialSemanticEnabled: boolean;
};

type IndexState = {
  status: "idle" | "running" | "done" | "error";
  message: string;
};

const knowledgeSearchHelp = {
  resultLimit:
    "Maximum number of evidence documents returned for the query. These are grant_knowledge_documents rows, not unique grant applications.",
  evidenceMatches:
    "Number of evidence documents available for this answer. AI grounded answers expand the initial retrieval matches with nearby source documents from the same top grant applications."
};

async function responseJson(response: Response) {
  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      response.ok
        ? "The server returned an invalid response."
        : `The server returned a non-JSON error response (${response.status}).`
    );
  }
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  return fallback;
}

function moneyText(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : null;
}

export function KnowledgeSearchPanel({
  canComposeAi,
  canIndex,
  canUseSemantic,
  initialAiConfigured,
  initialSemanticEnabled
}: KnowledgeSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("8");
  const [retrievalMode, setRetrievalMode] = useState<"keyword" | "semantic" | "hybrid">(
    canUseSemantic && initialSemanticEnabled ? "hybrid" : "keyword"
  );
  const [answerMode, setAnswerMode] = useState<"evidence" | "ai">("evidence");
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GrantKnowledgeSearchResponse | null>(null);
  const [indexState, setIndexState] = useState<IndexState>({ status: "idle", message: "" });
  const [embeddingState, setEmbeddingState] = useState<IndexState>({ status: "idle", message: "" });
  const aiAvailable = canComposeAi && initialAiConfigured;
  const semanticAvailable = canUseSemantic && initialSemanticEnabled;
  const answerModeNote = useMemo(() => {
    if (answerMode !== "ai") {
      return null;
    }

    if (!canComposeAi) {
      return "AI answers require an authenticated role with compose access.";
    }

    if (!initialAiConfigured) {
      return "AI answers need ZCG_KNOWLEDGE_AI_API_KEY or VENICE_API_KEY.";
    }

    return null;
  }, [answerMode, canComposeAi, initialAiConfigured]);
  const retrievalModeNote = useMemo(() => {
    if (retrievalMode === "keyword") {
      return null;
    }

    if (!canUseSemantic) {
      return "Semantic retrieval requires an authenticated role with semantic access.";
    }

    if (!initialSemanticEnabled) {
      return "Semantic retrieval needs a configured embedding key.";
    }

    return null;
  }, [retrievalMode, canUseSemantic, initialSemanticEnabled]);

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSearching(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: Number(limit), retrievalMode, answerMode })
      });
      const body = await responseJson(response);

      if (!response.ok) {
        throw new Error(errorMessage(body, "Search failed."));
      }

      setResult(body as GrantKnowledgeSearchResponse);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Search failed.");
    } finally {
      setIsSearching(false);
    }
  }

  async function rebuildIndex() {
    setIndexState({ status: "running", message: "Indexing grant knowledge." });

    try {
      const response = await fetch("/api/admin/knowledge/index", { method: "POST" });
      const body = await responseJson(response) as {
        accepted?: boolean;
        applicationsSeen?: number;
        documentsIndexed?: number;
        message?: string;
      } | null;

      if (!response.ok) {
        throw new Error(errorMessage(body, "Indexing failed."));
      }

      if (body?.accepted) {
        setIndexState({
          status: "done",
          message: body.message ?? "Knowledge index rebuild started. Refresh the page after it completes."
        });
        return;
      }

      setIndexState({
        status: "done",
        message: `${(body?.documentsIndexed ?? 0).toLocaleString()} documents indexed from ${(body?.applicationsSeen ?? 0).toLocaleString()} applications.`
      });
    } catch (indexError) {
      setIndexState({
        status: "error",
        message: indexError instanceof Error ? indexError.message : "Indexing failed."
      });
    }
  }

  async function rebuildEmbeddings() {
    setEmbeddingState({ status: "running", message: "Embedding the next grant knowledge batch with BGE-M3." });

    try {
      const response = await fetch("/api/admin/knowledge/embeddings", { method: "POST" });
      const body = await responseJson(response) as {
        documentsEmbedded?: number;
        model?: string;
      } | null;

      if (!response.ok) {
        throw new Error(errorMessage(body, "Embedding failed."));
      }

      setEmbeddingState({
        status: "done",
        message: `${(body?.documentsEmbedded ?? 0).toLocaleString()} documents embedded with ${body?.model ?? "the configured embedding model"}.`
      });
    } catch (embeddingError) {
      setEmbeddingState({
        status: "error",
        message: embeddingError instanceof Error ? embeddingError.message : "Embedding failed."
      });
    }
  }

  return (
    <div className="knowledge-workspace">
      <form className="knowledge-query-panel panel" onSubmit={submitSearch}>
        <div className="section-heading">
          <h2>Grant knowledge retrieval</h2>
          {canIndex ? (
            <div className="result-actions">
              <button disabled={indexState.status === "running"} onClick={rebuildIndex} type="button">
                {indexState.status === "running" ? "Indexing" : "Rebuild index"}
              </button>
              <button
                className="ghost-button"
                disabled={embeddingState.status === "running"}
                onClick={rebuildEmbeddings}
                type="button"
              >
                {embeddingState.status === "running" ? "Embedding" : "Embed next batch"}
              </button>
            </div>
          ) : null}
        </div>
        {canIndex ? (
          <details className="maintenance-callout">
            <summary>How rebuild and embedding work</summary>
            <p>
              Rebuild index regenerates the searchable text documents from canonical grant applications and their linked
              GitHub, Google Sheet, Forum, label, and reconciliation evidence. Embed next batch writes BGE-M3 vector
              embeddings for indexed documents that are new, missing, or stale. Keyword search can use rebuilt text
              immediately; semantic and hybrid retrieval are strongest after the embedding backlog is caught up.
            </p>
            <p>
              The scheduled embedding worker continues catching up in the background, so manual embedding is mainly for
              one-time catch-up or verification after a large rebuild.
            </p>
          </details>
        ) : null}
        <label className="knowledge-query-field">
          <span>Search</span>
          <textarea
            onChange={(event) => setQuery(event.target.value)}
            placeholder="similar grants for event sponsorship, wallets, infrastructure, education..."
            rows={4}
            value={query}
          />
        </label>
        <div className="table-controls knowledge-controls">
          <label className="search-field compact-field">
            <span>Retrieval</span>
            <select
              onChange={(event) => setRetrievalMode(event.target.value as "keyword" | "semantic" | "hybrid")}
              value={retrievalMode}
            >
              <option value="keyword">Keyword</option>
              <option disabled={!semanticAvailable} value="semantic">
                Semantic
              </option>
              <option disabled={!semanticAvailable} value="hybrid">
                Hybrid
              </option>
            </select>
          </label>
          <label className="search-field compact-field">
            <span>
              Results
              <MetricHelp align="left" body={knowledgeSearchHelp.resultLimit} label="Search result limit" />
            </span>
            <select onChange={(event) => setLimit(event.target.value)} value={limit}>
              <option value="5">5</option>
              <option value="8">8</option>
              <option value="12">12</option>
              <option value="20">20</option>
            </select>
          </label>
          <label className="search-field compact-field">
            <span>Answer</span>
            <select onChange={(event) => setAnswerMode(event.target.value as "evidence" | "ai")} value={answerMode}>
              <option value="evidence">Evidence summary</option>
              <option disabled={!aiAvailable} value="ai">
                AI grounded answer
              </option>
            </select>
          </label>
          <button disabled={isSearching || !query.trim()} type="submit">
            {isSearching ? "Searching" : "Search"}
          </button>
        </div>
        {retrievalModeNote ? <p className="form-status neutral-status">{retrievalModeNote}</p> : null}
        {answerModeNote ? <p className="form-status neutral-status">{answerModeNote}</p> : null}
        {indexState.message ? (
          <p className={indexState.status === "error" ? "form-error" : "form-status"}>{indexState.message}</p>
        ) : null}
        {embeddingState.message ? (
          <p className={embeddingState.status === "error" ? "form-error" : "form-status"}>{embeddingState.message}</p>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
      </form>

      {result ? (
        <section className="panel knowledge-results">
          <div className="section-heading">
            <div>
              <h2>Grounded answer</h2>
              <span className="section-count">
                {result.retrievalStats.resultCount.toLocaleString()} evidence matches
                <MetricHelp align="left" body={knowledgeSearchHelp.evidenceMatches} label="Evidence matches" />
                {" | "}
                {result.retrievalStats.mode} retrieval
                {result.retrievalStats.expandedEvidenceCount > result.retrievalStats.initialResultCount ? (
                  <>
                    {" | "}
                    expanded from {result.retrievalStats.initialResultCount.toLocaleString()}
                  </>
                ) : null}
              </span>
            </div>
            <span className={`badge ${result.answerStatus === "generated" ? "green" : "neutral"}`}>
              {result.answerStatus === "generated" ? "AI" : "Grounded"}
            </span>
          </div>
          {result.answerText ? <pre className="knowledge-answer">{result.answerText}</pre> : null}
          <div className="evidence-list knowledge-citations">
            {result.results.map((item, index) => (
              <article className="evidence-item" key={item.id}>
                <div className="issue-heading">
                  <span className="badge neutral">[{index + 1}]</span>
                  {item.sourceKind ? <span className="badge">{item.sourceKind}</span> : null}
                  {item.normalizedStatus ? <span className={`badge ${item.normalizedStatus}`}>{item.normalizedStatus}</span> : null}
                </div>
                <h3>{item.title}</h3>
                <p>{item.excerpt}</p>
                <dl className="evidence-meta">
                  <div>
                    <dt>Applicant</dt>
                    <dd>{item.applicantName ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Requested</dt>
                    <dd>{moneyText(item.requestedAmountUsd) ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{item.sourceId ?? item.documentKind}</dd>
                  </div>
                  <div>
                    <dt>Rank</dt>
                    <dd>{Number.isFinite(item.rank) ? item.rank.toFixed(3) : "-"}</dd>
                  </div>
                </dl>
                <div className="result-actions">
                  <a className="table-link" href={`/admin/grants/${item.applicationId}`} rel="noreferrer" target="_blank">
                    Open application
                  </a>
                  {item.sourceUrl ? (
                    <a className="table-link" href={item.sourceUrl} rel="noreferrer" target="_blank">
                      Open source
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
