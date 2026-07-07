"use client";

import { useState } from "react";

type MetricHelpProps = {
  label: string;
  body: string;
  align?: "left" | "right";
};

type MetricLabelProps = MetricHelpProps & {
  text: string;
};

export function MetricHelp({ label, body, align = "right" }: MetricHelpProps) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`metric-help ${align === "left" ? "align-left" : ""}`}
      onBlur={(event) => {
        const nextFocus = event.relatedTarget as Node | null;

        if (!nextFocus || !event.currentTarget.contains(nextFocus)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-expanded={open}
        aria-label={`${label} details`}
        className="metric-help-button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        title={`${label} details`}
        type="button"
      >
        <span aria-hidden="true">i</span>
      </button>
      {open ? (
        <span className="metric-help-popover" role="note">
          <span className="metric-help-title">{label}</span>
          <span>{body}</span>
        </span>
      ) : null}
    </span>
  );
}

export function MetricLabel({ text, label, body, align }: MetricLabelProps) {
  return (
    <span className="metric-label metric-label-with-help">
      <span>{text}</span>
      <MetricHelp align={align} body={body} label={label} />
    </span>
  );
}
