"use client";
// Small motion primitives. The styles live in app/ui.css ("motion primitives"); every one of them is off
// under prefers-reduced-motion.
import { useEffect, useRef } from "react";

/**
 * A number whose characters pop in one after another (adapted from transitions.dev "Number pop-in").
 * Keyed by its text, so a new value plays again and an unchanged one does not.
 */
export function PopNumber({ text }: { text: string }) {
  return (
    <span className="t-digit-group is-animating" key={text}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {[...text].map((ch, i) => (
          <span
            key={i}
            className="t-digit"
            style={{ ["--i" as string]: Math.min(i, 8) }}
          >
            {ch === " " ? " " : ch}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A check mark that draws itself while it fades, turns and settles into place (adapted from
 * transitions.dev "Success check"). It plays when it mounts; give it a new key to play it again.
 */
export function SuccessCheck({
  size = 16,
  delay = 0,
  animate = true,
  className = "",
}: {
  size?: number;
  delay?: number;
  /** false draws it finished, for a result the person did not just produce. */
  animate?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`t-success-check ${className}`}
      data-state={animate ? "in" : "done"}
      aria-hidden="true"
      style={delay ? { ["--check-delay" as string]: `${delay}ms` } : undefined}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
      </svg>
    </span>
  );
}

/**
 * Shakes an element each time `signal` changes to a truthy value (adapted from transitions.dev "Error
 * state shake"): the class is removed and re-added with a reflow in between, so a repeated error shakes
 * again.
 */
export function useShake<T extends HTMLElement>(signal: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !signal) return;
    el.classList.remove("t-shake");
    void el.offsetWidth;
    el.classList.add("t-shake");
  }, [signal]);
  return ref;
}
