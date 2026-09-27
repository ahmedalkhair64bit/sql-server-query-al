// Decorative background for sign-in, sign-up and onboarding: slowly drifting light and a faint execution
// plan whose arrows carry rows toward the root, as a plan's data flows right to left. CSS only, no script;
// it stays still for people who ask for reduced motion.
const NODES: [number, number][] = [
  [90, 300],
  [300, 180],
  [300, 420],
  [520, 110],
  [520, 250],
  [520, 470],
  [740, 190],
  [740, 330],
  [960, 250],
];
const EDGES: [number, number][] = [
  [1, 0],
  [2, 0],
  [3, 1],
  [4, 1],
  [5, 2],
  [6, 4],
  [7, 4],
  [8, 6],
  [8, 7],
];

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <span className="backdrop-glow g1" />
      <span className="backdrop-glow g2" />
      <span className="backdrop-glow g3" />
      <svg
        className="backdrop-plan"
        viewBox="0 0 1060 560"
        preserveAspectRatio="xMidYMid slice"
      >
        {EDGES.map(([from, to], i) => {
          const [x1, y1] = NODES[from],
            [x2, y2] = NODES[to];
          const mid = (x1 + x2) / 2;
          const d = `M${x1 - 44} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2 + 44} ${y2}`;
          return (
            <g key={i}>
              <path className="edge" d={d} />
              <path
                className="flow"
                d={d}
                style={{ animationDelay: `${-i * 0.7}s` }}
              />
            </g>
          );
        })}
        {NODES.map(([x, y], i) => (
          <rect
            key={i}
            className="node"
            x={x - 44}
            y={y - 22}
            width={88}
            height={44}
            rx={10}
            style={{ animationDelay: `${-i * 0.9}s` }}
          />
        ))}
      </svg>
    </div>
  );
}
