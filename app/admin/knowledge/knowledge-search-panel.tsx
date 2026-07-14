"use client";

import { useMemo, useRef, useState } from "react";
import type { GrantKnowledgeSearchResponse } from "@/lib/knowledge/search";
import { MetricHelp } from "../metric-help";

type KnowledgeSearchPanelProps = {
  canComposeAi: boolean;
  canIndex: boolean;
  canUseSemantic: boolean;
  isPublicViewer: boolean;
  initialAiConfigured: boolean;
  initialSemanticEnabled: boolean;
};

type IndexState = {
  status: "idle" | "running" | "done" | "error";
  message: string;
};

type KnowledgeAnswerJobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

type KnowledgeAnswerJobResponse = {
  accepted?: boolean;
  jobId: string;
  status: KnowledgeAnswerJobStatus;
  result?: GrantKnowledgeSearchResponse | null;
  error?: { message?: string } | null;
  pollAfterMs?: number;
};

const knowledgeSearchHelp = {
  resultLimit:
    "Initial search-result size for the query. Evidence-summary mode returns this many documents. AI grounded-answer mode can use a larger answer-preparation pass behind the scenes.",
  evidenceMatches:
    "Number of evidence documents prepared for this answer. AI grounded answers run a wider candidate pass, expand top grant applications with nearby source documents, and include compact summaries for broader matching applications."
};

const defaultPollMs = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPollMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 750), 5000) : fallback;
}

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

function searchErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Search failed.";

  if (["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."].includes(message)) {
    return "The search request did not complete. Try again, or use Evidence summary for a broad query.";
  }

  return message;
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

function answerBadgeText(status: GrantKnowledgeSearchResponse["answerStatus"]) {
  if (status === "generated") {
    return "AI";
  }

  if (status === "fallback") {
    return "Evidence fallback";
  }

  return "Grounded";
}

function isKnowledgeAnswerJobResponse(value: unknown): value is KnowledgeAnswerJobResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as { jobId?: unknown; status?: unknown };
  return typeof record.jobId === "string" && typeof record.status === "string";
}

export function KnowledgeSearchPanel({
  canComposeAi,
  canIndex,
  canUseSemantic,
  isPublicViewer,
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
  const [activeJob, setActiveJob] = useState<{ jobId: string; status: KnowledgeAnswerJobStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GrantKnowledgeSearchResponse | null>(null);
  const [refreshState, setRefreshState] = useState<IndexState>({ status: "idle", message: "" });
  const [indexState, setIndexState] = useState<IndexState>({ status: "idle", message: "" });
  const [embeddingState, setEmbeddingState] = useState<IndexState>({ status: "idle", message: "" });
  const runTokenRef = useRef(0);
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
      return "Semantic retrieval is not available for this account.";
    }

    if (!initialSemanticEnabled) {
      return "Semantic retrieval needs a configured embedding key.";
    }

    return null;
  }, [retrievalMode, canUseSemantic, initialSemanticEnabled]);
  const selectedSearchExplanation = useMemo(() => {
    const resultCount = Number(limit).toLocaleString();
    const retrieval = {
      keyword:
        "Searches the indexed text for matching words and phrases, with extra weight for matches in titles, applicant names, and source identifiers.",
      semantic:
        "Compares the meaning of your query with each knowledge document’s embedding, so related concepts can match even when they use different wording.",
      hybrid:
        "Combines keyword matches with semantic similarity, then merges both rankings to surface records that are strong by wording, meaning, or both."
    }[retrievalMode];
    const answer =
      answerMode === "evidence"
        ? `Returns up to ${resultCount} matching evidence documents and a short, non-AI list of the leading matches.`
        : `Uses a wider candidate search, gathers linked evidence around the strongest applications, and asks the configured AI model for a grounded answer with citations. The ${resultCount}-result setting controls the initial matches.`;

    return { retrieval, answer };
  }, [answerMode, limit, retrievalMode]);

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setIsSearching(true);
    setActiveJob(null);
    setError(null);
    setResult(null);

    try {
      if (answerMode === "ai") {
        await submitAsyncAnswerJob(runToken);
        return;
      }

      const response = await fetch("/api/admin/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: Number(limit), retrievalMode, answerMode })
      });
      const body = await responseJson(response);

      if (!response.ok) {
        throw new Error(errorMessage(body, "Search failed."));
      }

      if (runTokenRef.current === runToken) {
        setResult(body as GrantKnowledgeSearchResponse);
      }
    } catch (searchError) {
      if (runTokenRef.current === runToken) {
        setError(searchErrorMessage(searchError));
      }
    } finally {
      if (runTokenRef.current === runToken) {
        setIsSearching(false);
      }
    }
  }

  async function submitAsyncAnswerJob(runToken: number) {
    const response = await fetch("/api/admin/knowledge/search/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: Number(limit), retrievalMode, answerMode })
    });
    const body = await responseJson(response);

    if (!response.ok) {
      throw new Error(errorMessage(body, "Search failed."));
    }

    if (!isKnowledgeAnswerJobResponse(body)) {
      throw new Error("Invalid knowledge answer job response.");
    }

    if (runTokenRef.current !== runToken) {
      return;
    }

    setActiveJob({ jobId: body.jobId, status: body.status });
    let pollDelayMs = clampPollMs(body.pollAfterMs, defaultPollMs);

    while (runTokenRef.current === runToken) {
      await sleep(pollDelayMs);

      if (runTokenRef.current !== runToken) {
        return;
      }

      const pollResponse = await fetch(`/api/admin/knowledge/search/jobs/${encodeURIComponent(body.jobId)}`, {
        method: "GET",
        cache: "no-store"
      });
      const pollBody = await responseJson(pollResponse);

      if (!pollResponse.ok) {
        throw new Error(errorMessage(pollBody, "Search failed."));
      }

      if (!isKnowledgeAnswerJobResponse(pollBody)) {
        throw new Error("Invalid knowledge answer job status response.");
      }

      setActiveJob({ jobId: pollBody.jobId, status: pollBody.status });

      if (pollBody.status === "succeeded") {
        if (!pollBody.result) {
          throw new Error("Knowledge answer job completed without a result.");
        }

        setResult(pollBody.result);
        return;
      }

      if (pollBody.status === "failed" || pollBody.status === "expired") {
        throw new Error(
          pollBody.error?.message ||
            (pollBody.status === "expired"
              ? "Knowledge answer job expired before completing."
              : "Knowledge answer job failed.")
        );
      }

      pollDelayMs = clampPollMs(pollBody.pollAfterMs, pollDelayMs);
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

  async function refreshCorpus() {
    setRefreshState({ status: "running", message: "Starting a full corpus refresh." });

    try {
      const response = await fetch("/api/admin/knowledge/refresh", { method: "POST" });
      const body = await responseJson(response) as {
        accepted?: boolean;
        message?: string;
      } | null;

      if (!response.ok) {
        throw new Error(errorMessage(body, "Corpus refresh could not be started."));
      }

      if (!body?.accepted) {
        throw new Error("The server did not accept the corpus refresh request.");
      }

      setRefreshState({
        status: "done",
        message:
          body.message ??
          "Corpus refresh started. Source mirroring, reconciliation, and knowledge indexing will continue in the background."
      });
    } catch (refreshError) {
      setRefreshState({
        status: "error",
        message: refreshError instanceof Error ? refreshError.message : "Corpus refresh could not be started."
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
        </div>
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
        <aside aria-live="polite" className="knowledge-search-explainer">
          <p className="knowledge-search-explainer-title">What this search will do</p>
          <dl>
            <div>
              <dt>Retrieval</dt>
              <dd>{selectedSearchExplanation.retrieval}</dd>
            </div>
            <div>
              <dt>Answer</dt>
              <dd>{selectedSearchExplanation.answer}</dd>
            </div>
          </dl>
          <p className="knowledge-search-embedding-note">
            <strong>How semantic search works.</strong> Applications and their linked GitHub, Forum, Google Sheet,
            label, decision, and reconciliation evidence are stored as individual knowledge documents. Each current
            document is processed into its own embedding for semantic and hybrid retrieval.
          </p>
          {isPublicViewer ? (
            <p className="knowledge-search-embedding-note">
              <strong>Public-use controls.</strong> Anonymous semantic and hybrid evidence searches have short-term and
              daily usage limits. If a limit is reached, the same request automatically uses keyword retrieval instead.
              Query text and network addresses are not stored in public-search telemetry.
            </p>
          ) : null}
        </aside>
        {canIndex ? (
          <details className="maintenance-callout knowledge-maintenance">
            <summary>Corpus maintenance</summary>
            <div className="result-actions">
              <button disabled={refreshState.status === "running"} onClick={refreshCorpus} type="button">
                {refreshState.status === "running" ? "Starting refresh" : "Refresh corpus"}
              </button>
              <button
                className="ghost-button"
                disabled={indexState.status === "running"}
                onClick={rebuildIndex}
                type="button"
              >
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
            <p>
              Refresh corpus mirrors all configured public sources, reconciles their records into canonical grant
              applications, and then rebuilds the knowledge index. Use it when a new or changed application is missing.
            </p>
            <p>
              Rebuild index only regenerates searchable documents from canonical applications already in this system; it
              does not fetch new or changed source records. Embed next batch writes BGE-M3 vector embeddings for indexed
              documents that are new, missing, or stale. Keyword search can use rebuilt text immediately; semantic and
              hybrid retrieval are strongest after the embedding backlog is caught up.
            </p>
            <p>
              The scheduled embedding worker continues catching up in the background, so manual embedding is mainly for
              one-time catch-up or verification after a large rebuild.
            </p>
          </details>
        ) : null}
        {retrievalModeNote ? <p className="form-status neutral-status">{retrievalModeNote}</p> : null}
        {answerModeNote ? <p className="form-status neutral-status">{answerModeNote}</p> : null}
        {refreshState.message ? (
          <p className={refreshState.status === "error" ? "form-error" : "form-status"}>{refreshState.message}</p>
        ) : null}
        {indexState.message ? (
          <p className={indexState.status === "error" ? "form-error" : "form-status"}>{indexState.message}</p>
        ) : null}
        {embeddingState.message ? (
          <p className={embeddingState.status === "error" ? "form-error" : "form-status"}>{embeddingState.message}</p>
        ) : null}
        {isSearching && activeJob ? (
          <p className="form-status neutral-status">Answer job {activeJob.jobId.slice(0, 8)} is {activeJob.status}.</p>
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
                {result.retrievalStats.candidateResultCount > result.retrievalStats.initialResultCount ? (
                  <>
                    {" | "}
                    {result.retrievalStats.candidateResultCount.toLocaleString()} candidates
                  </>
                ) : null}
                {result.retrievalStats.expandedEvidenceCount > result.retrievalStats.initialResultCount ? (
                  <>
                    {" | "}
                    expanded from {result.retrievalStats.initialResultCount.toLocaleString()}
                  </>
                ) : null}
              </span>
            </div>
            <span className={`badge ${result.answerStatus === "generated" ? "green" : "neutral"}`}>
              {answerBadgeText(result.answerStatus)}
            </span>
          </div>
          {result.retrievalNotice ? (
            <p className="form-status neutral-status">{result.retrievalNotice}</p>
          ) : null}
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
