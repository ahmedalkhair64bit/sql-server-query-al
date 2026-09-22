import type { CSSProperties } from "react";
const paths: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  panel: "M3 4h18v16H3zM9 4v16",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  file: "M14 2H5v20h14V7l-5-5v5h5M8 12h8M8 16h8",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  moon: "M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3",
  chart: "M4 20V10m8 10V4m8 16V8",
  shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6zM8 12l3 3 5-6",
  logout: "M9 4H4v16h5m5-14 6 6-6 6M8 12h12",
};
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name] ?? paths.file} />
    </svg>
  );
}
