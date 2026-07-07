"use client";

import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type MetricHelpProps = {
  label: string;
  body: string;
  align?: "left" | "right";
};

type MetricLabelProps = MetricHelpProps & {
  text: string;
};

type PopoverPosition = {
  left: number;
  top: number;
  width: number;
};

const popoverMaxWidth = 340;
const viewportMargin = 16;
const popoverGap = 10;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function MetricHelp({ label, body, align = "right" }: MetricHelpProps) {
  const popoverId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const updatePosition = useCallback(() => {
    const button = buttonRef.current;

    if (!button) {
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    const availableWidth = Math.max(180, window.innerWidth - viewportMargin * 2);
    const width = Math.min(popoverMaxWidth, availableWidth);
    const preferredLeft = align === "left" ? buttonRect.left : buttonRect.right - width;
    const left = clamp(preferredLeft, viewportMargin, window.innerWidth - width - viewportMargin);
    const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
    const belowTop = buttonRect.bottom + popoverGap;
    const aboveTop = buttonRect.top - popoverHeight - popoverGap;
    const needsAbove = popoverHeight > 0 && belowTop + popoverHeight > window.innerHeight - viewportMargin;
    const top = needsAbove ? Math.max(viewportMargin, aboveTop) : belowTop;

    setPosition({ left, top, width });
  }, [align]);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    updatePosition();
    const animationFrame = window.requestAnimationFrame(updatePosition);

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    function closeOnOutsideInteraction(event: Event) {
      const target = event.target as Node | null;

      if (!target || buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsideInteraction);
    document.addEventListener("focusin", closeOnOutsideInteraction);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsideInteraction);
      document.removeEventListener("focusin", closeOnOutsideInteraction);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const popoverStyle: CSSProperties | undefined = position
    ? {
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${position.width}px`
      }
    : undefined;

  return (
    <span className="metric-help">
      <button
        aria-controls={open ? popoverId : undefined}
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        aria-label={`${label} details`}
        className="metric-help-button"
        ref={buttonRef}
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
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              className={`metric-help-popover ${position ? "positioned" : ""}`}
              id={popoverId}
              ref={popoverRef}
              role="tooltip"
              style={popoverStyle}
            >
              <span className="metric-help-title">{label}</span>
              <span>{body}</span>
            </span>,
            document.body
          )
        : null}
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
