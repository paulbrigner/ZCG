"use client";

import { useState } from "react";

type RefreshState = {
  status: "idle" | "running" | "done" | "error";
  message: string;
};

async function responseJson(response: Response) {
  return response.json().catch(() => null) as Promise<{ accepted?: boolean; error?: string; message?: string } | null>;
}

export function CorpusRefreshButton() {
  const [state, setState] = useState<RefreshState>({ status: "idle", message: "" });

  async function refreshCorpus() {
    setState({ status: "running", message: "Starting the corpus refresh." });

    try {
      const response = await fetch("/api/admin/knowledge/refresh", { method: "POST" });
      const body = await responseJson(response);

      if (!response.ok || !body?.accepted) {
        throw new Error(body?.error ?? "Corpus refresh could not be started.");
      }

      setState({
        status: "done",
        message: body.message ?? "Corpus refresh started. Progress is available on the Telemetry page."
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Corpus refresh could not be started."
      });
    }
  }

  return (
    <div className="status-list">
      <button disabled={state.status === "running"} onClick={refreshCorpus} type="button">
        {state.status === "running" ? "Starting refresh" : "Refresh corpus"}
      </button>
      {state.message ? (
        <p aria-live="polite" className={state.status === "error" ? "form-error" : "form-status"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
