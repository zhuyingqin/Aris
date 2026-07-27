import { useMemo, type CSSProperties } from "react";

// Animated sign-in dreamscape. Two pieces: a full-bleed night backdrop
// (aurora drift, twinkling starfield, shooting stars, drifting dust motes)
// and the hero scene — faithful to the app logo: a left-opening crescent
// moon holding the knowledge-graph constellation in its mouth, sparkles at
// the logo's positions (upper-left of the moon, below it, above the graph),
// and the logo's luminous wave sweeping from the moon's lower horn down to
// a glowing pearl. Below, a sleeping researcher whose soul rises out of the
// body, plucks a star off the moon's horn, and lights up the graph.
// Pure SVG + CSS keyframes (see login.css); no JS animation loops.

type StarVar = CSSProperties & { "--delay"?: string; "--dur"?: string; "--i"?: number; "--dx"?: string };

/** Deterministic PRNG so the starfield is stable across re-renders. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function LoginBackdrop() {
  const stars = useMemo(() => {
    const rand = mulberry32(20260717);
    return Array.from({ length: 110 }, () => ({
      x: +(rand() * 100).toFixed(2),
      y: +(rand() * 100).toFixed(2),
      r: +(0.05 + rand() * 0.11).toFixed(3),
      delay: +(rand() * 6).toFixed(2),
      dur: +(2.6 + rand() * 4).toFixed(2),
    }));
  }, []);

  // Slow luminous dust drifting up — the Kimi-style ambient layer.
  const dust = useMemo(() => {
    const rand = mulberry32(915);
    return Array.from({ length: 9 }, () => ({
      x: +(rand() * 100).toFixed(2),
      y: +(52 + rand() * 46).toFixed(2),
      s: +(2 + rand() * 3.5).toFixed(1),
      dur: +(14 + rand() * 16).toFixed(1),
      delay: +(-rand() * 30).toFixed(1),
      dx: +((rand() - 0.5) * 10).toFixed(1),
    }));
  }, []);

  return (
    <div className="sq-backdrop" aria-hidden="true">
      <div className="sq-aurora sq-aurora-a" />
      <div className="sq-aurora sq-aurora-b" />
      <div className="sq-aurora sq-aurora-c" />
      <svg className="sq-stars" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        {stars.map((s, i) => (
          <circle
            key={i}
            className="sq-star"
            cx={s.x}
            cy={s.y}
            r={s.r}
            style={{ "--delay": `${s.delay}s`, "--dur": `${s.dur}s` } as StarVar}
          />
        ))}
      </svg>
      {dust.map((d, i) => (
        <div
          key={`dust-${i}`}
          className="sq-dust"
          style={{
            left: `${d.x}%`,
            top: `${d.y}%`,
            width: `${d.s}px`,
            height: `${d.s}px`,
            "--delay": `${d.delay}s`,
            "--dur": `${d.dur}s`,
            "--dx": `${d.dx}vw`,
          } as StarVar}
        />
      ))}
      <div className="sq-shooting sq-shooting-a" />
      <div className="sq-shooting sq-shooting-b" />
    </div>
  );
}

// Knowledge-graph constellation nested in the moon's embrace, mirroring the
// logo: it sits in the crescent's open mouth, right of the moon's belly.
const NODES: Array<[number, number, number, "a" | "b" | "c"]> = [
  [405, 258, 6.5, "b"], // n1 crown
  [345, 303, 5.5, "b"], // n2 upper-left
  [465, 306, 6, "b"], // n3 upper-right
  [405, 346, 7.5, "a"], // n4 hub — the plucked star lands here
  [342, 382, 5.5, "c"], // n5 lower-left
  [468, 378, 5.5, "c"], // n6 lower-right
];

const EDGES: Array<[number, number, "a" | "b" | "c"]> = [
  [0, 3, "a"],
  [1, 3, "a"],
  [2, 3, "a"],
  [3, 4, "a"],
  [3, 5, "a"],
  [0, 1, "b"],
  [0, 2, "b"],
  [1, 4, "c"],
  [2, 5, "c"],
];

const GLYPHS: Array<{ x: number; y: number; size: number; delay: number; dur: number; kind: "sum" | "psi" | "nabla" | "pi" | "infinity" }> = [
  { x: 582, y: 468, size: 17, delay: 0.8, dur: 11, kind: "sum" },
  { x: 566, y: 380, size: 14, delay: 4.2, dur: 13, kind: "psi" },
  { x: 178, y: 430, size: 15, delay: 2.6, dur: 12, kind: "nabla" },
  { x: 552, y: 545, size: 13, delay: 6.5, dur: 10, kind: "pi" },
  { x: 150, y: 330, size: 13, delay: 8.2, dur: 12, kind: "infinity" },
];

function DreamGlyph({ kind }: { kind: (typeof GLYPHS)[number]["kind"] }) {
  if (kind === "sum") return <path d="M6-7h-12l7 7-7 7H6L-1 0z" fill="none" stroke="currentColor" strokeLinejoin="round" />;
  if (kind === "psi") return <path d="M0-8v16M-5-3c0 8 10 8 10 0M0-8v-2" fill="none" stroke="currentColor" strokeLinecap="round" />;
  if (kind === "nabla") return <path d="M0-7 6 6H-6z" fill="none" stroke="currentColor" strokeLinejoin="round" />;
  if (kind === "pi") return <path d="M-6-6H6M-4-6v12M4-6v12" fill="none" stroke="currentColor" strokeLinecap="round" />;
  return <path d="M-7 0c2-5 5-5 7 0 2 5 5 5 7 0 2-5 5-5 7 0-2 5-5 5-7 0-2-5-5-5-7 0-2 5-5 5-7 0z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />;
}

export function DreamScene() {
  return (
    <svg className="sq-hero-svg" viewBox="0 0 720 720" aria-hidden="true">
      <defs>
        <linearGradient id="sq-moon-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#c7ddff" />
        </linearGradient>
        <linearGradient id="sq-edge-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="sq-soul-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(165,224,252,0.95)" />
          <stop offset="78%" stopColor="rgba(125,180,252,0.35)" />
          <stop offset="100%" stopColor="rgba(125,180,252,0.04)" />
        </linearGradient>
        <linearGradient id="sq-wisp-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(147,197,253,0.55)" />
          <stop offset="100%" stopColor="rgba(147,197,253,0.05)" />
        </linearGradient>
        {/* the logo's wave: dim at the moon's horn, brightening toward the pearl */}
        <linearGradient id="sq-tail-g" gradientUnits="userSpaceOnUse" x1="298" y1="380" x2="512" y2="466">
          <stop offset="0%" stopColor="rgba(199,221,255,0.22)" />
          <stop offset="55%" stopColor="rgba(214,232,255,0.72)" />
          <stop offset="100%" stopColor="#f4faff" />
        </linearGradient>
        <radialGradient id="sq-orb-g" cx="0.38" cy="0.35" r="0.9">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#d9ecff" />
          <stop offset="100%" stopColor="#8fb8e8" />
        </radialGradient>
        <radialGradient id="sq-head-g" cx="0.35" cy="0.3" r="1">
          <stop offset="0%" stopColor="#2a3a5e" />
          <stop offset="100%" stopColor="#1a2440" />
        </radialGradient>
        <filter id="sq-blur-s" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <filter id="sq-blur-m" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="sq-blur-l" x="-90%" y="-90%" width="280%" height="280%">
          <feGaussianBlur stdDeviation="15" />
        </filter>
        <mask id="sq-moon-mask">
          <circle cx="250" cy="240" r="148" fill="#fff" />
          <circle cx="300" cy="232" r="132" fill="#000" />
        </mask>
      </defs>

      {/* -------- moon (crescent + the logo's luminous wave, orbit ring) -------- */}
      <g>
        <circle
          className="sq-moon-glow"
          cx="212"
          cy="248"
          r="128"
          fill="#93b8f0"
          filter="url(#sq-blur-l)"
        />
        {/* breathing pulse ring radiating from the moon */}
        <circle
          className="sq-pulse"
          cx="250"
          cy="240"
          r="150"
          fill="none"
          stroke="#93c5fd"
          strokeWidth="2"
        />
        {/* tilted orbit shell with a satellite light riding it */}
        <g transform="rotate(-16 250 240)">
          <ellipse
            cx="250"
            cy="240"
            rx="205"
            ry="92"
            fill="none"
            stroke="#7dd3fc"
            strokeWidth="1"
            opacity="0.22"
            strokeDasharray="2 7"
          />
          <circle
            className="sq-sat"
            r="3.5"
            fill="#a5f3fc"
            filter="url(#sq-blur-s)"
            style={{ offsetPath: "path('M 45 240 a 205 92 0 1 1 410 0 a 205 92 0 1 1 -410 0')" }}
          />
        </g>
        <rect
          x="86"
          y="76"
          width="330"
          height="330"
          fill="url(#sq-moon-g)"
          mask="url(#sq-moon-mask)"
        />
        {/* the logo's wave: rooted on the crescent's lower horn (298,380),
            sweeping right-down to a glowing pearl — like the logo's ribbon */}
        <path
          d="M 298 380 C 330 442 352 500 424 508 C 452 511 484 496 505 468"
          stroke="url(#sq-tail-g)"
          strokeWidth="24"
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
        {/* light flowing along the wave into the pearl */}
        <path
          className="sq-tail-shimmer"
          d="M 298 380 C 330 442 352 500 424 508 C 452 511 484 496 505 468"
          stroke="#e0fbff"
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        />
        <circle
          className="sq-orb-glow"
          cx="508"
          cy="462"
          r="26"
          fill="#a5f3fc"
          filter="url(#sq-blur-m)"
        />
        <circle cx="508" cy="462" r="16" fill="url(#sq-orb-g)" />
        {/* four-point sparkles at the logo's positions: upper-left of the
            moon (the big one), below the moon, above the constellation */}
        <path
          className="sq-sparkle"
          d="M 0 -9 L 2 -2 L 9 0 L 2 2 L 0 9 L -2 2 L -9 0 L -2 -2 Z"
          transform="translate(100 125)"
          fill="#a5f3fc"
          style={{ "--delay": "0.6s" } as StarVar}
        />
        <path
          className="sq-sparkle"
          d="M 0 -6 L 1.4 -1.4 L 6 0 L 1.4 1.4 L 0 6 L -1.4 1.4 L -6 0 L -1.4 -1.4 Z"
          transform="translate(115 385)"
          fill="#a5f3fc"
          style={{ "--delay": "2.4s" } as StarVar}
        />
        <path
          className="sq-sparkle"
          d="M 0 -5 L 1.2 -1.2 L 5 0 L 1.2 1.2 L 0 5 L -1.2 1.2 L -5 0 L -1.2 -1.2 Z"
          transform="translate(478 152)"
          fill="#a5f3fc"
          style={{ "--delay": "4.1s" } as StarVar}
        />
      </g>

      {/* -------- constellation: dim base graph, always visible -------- */}
      <g>
        {EDGES.map(([a, b], i) => (
          <line
            key={`base-${i}`}
            x1={NODES[a][0]}
            y1={NODES[a][1]}
            x2={NODES[b][0]}
            y2={NODES[b][1]}
            stroke="#3b82f6"
            strokeWidth="1.6"
            opacity="0.28"
          />
        ))}
        {NODES.map(([x, y, r], i) => (
          <circle key={`node-${i}`} cx={x} cy={y} r={r} fill="#3b82f6" opacity="0.5" />
        ))}
      </g>

      {/* -------- SVG science marks drifting up around the scene -------- */}
      <g>
        {GLYPHS.map((g, i) => (
          <g key={i} transform={`translate(${g.x} ${g.y}) scale(${g.size / 16})`}>
            <g className="sq-glyph" style={{ "--delay": `${g.delay}s`, "--dur": `${g.dur}s` } as StarVar}>
              <DreamGlyph kind={g.kind} />
            </g>
          </g>
        ))}
      </g>

      {/* -------- sleeping researcher at the desk -------- */}
      <ellipse cx="330" cy="662" rx="215" ry="13" fill="#0b1226" opacity="0.65" />
      <g className="sq-sleeper">
        {/* chair */}
        <rect x="166" y="538" width="9" height="66" rx="4" fill="#182342" />
        <rect x="170" y="600" width="78" height="9" rx="4" fill="#182342" />
        <rect x="178" y="609" width="7" height="48" fill="#141d38" />
        <rect x="230" y="609" width="7" height="48" fill="#141d38" />
        {/* desk */}
        <rect x="150" y="585" width="352" height="10" rx="5" fill="#1b2748" />
        <rect x="150" y="585" width="352" height="3" rx="1.5" fill="#2c3e63" opacity="0.6" />
        <rect x="160" y="595" width="9" height="64" fill="#141d38" />
        <rect x="484" y="595" width="9" height="64" fill="#141d38" />
        {/* body: hunched torso as a round-capped stroke, head resting on arms */}
        <path
          d="M 218 598 Q 230 550 288 537"
          stroke="#202c49"
          strokeWidth="44"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="265" y="556" width="150" height="26" rx="13" fill="#202c49" />
        <circle cx="318" cy="528" r="30" fill="url(#sq-head-g)" />
        {/* mug with steam */}
        <rect x="424" y="562" width="21" height="23" rx="3" fill="#243252" />
        <path
          d="M 445 567 q 9 4 0 12"
          stroke="#243252"
          strokeWidth="3.5"
          fill="none"
        />
        <path
          className="sq-steam"
          d="M 430 556 q 4 -7 0 -13 q -4 -6 1 -11"
          stroke="#8fb3e8"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
          style={{ "--delay": "0s" } as StarVar}
        />
        <path
          className="sq-steam"
          d="M 438 556 q -4 -7 0 -13 q 4 -6 -1 -11"
          stroke="#8fb3e8"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
          style={{ "--delay": "1.7s" } as StarVar}
        />
        {/* books */}
        <rect x="452" y="577" width="44" height="8" rx="2" fill="#22335c" />
        <rect x="456" y="569" width="38" height="8" rx="2" fill="#1c2a4e" />
        <rect x="460" y="561" width="30" height="8" rx="2" fill="#243863" />
      </g>

      {/* zzz drifting from the sleeper's head */}
      <g fill="#93c5fd" fontStyle="italic" fontWeight="600">
        <text className="sq-zzz" x="352" y="506" fontSize="13" style={{ "--delay": "0s" } as StarVar}>z</text>
        <text className="sq-zzz" x="368" y="488" fontSize="17" style={{ "--delay": "1.6s" } as StarVar}>z</text>
        <text className="sq-zzz" x="386" y="466" fontSize="22" style={{ "--delay": "3.2s" } as StarVar}>Z</text>
      </g>

      {/* dream motes rising off the sleeper, drifting through the wave */}
      <g>
        {([
          [338, 522, 3.2, 0, 9, -14],
          [368, 508, 2.4, 2.8, 11, 10],
          [392, 532, 2.8, 5.4, 10, -8],
          [356, 548, 2.2, 7.6, 12, 16],
          [414, 518, 2.6, 4.1, 9.5, -18],
        ] as Array<[number, number, number, number, number, number]>).map(([x, y, r, delay, dur, dx], i) => (
          <circle
            key={`mote-${i}`}
            className="sq-mote"
            cx={x}
            cy={y}
            r={r}
            style={{ "--delay": `${delay}s`, "--dur": `${dur}s`, "--dx": `${dx}px` } as StarVar}
          />
        ))}
      </g>

      {/* -------- the soul, rising out of the sleeper -------- */}
      <g className="sq-soul-rise">
        {/* wisp tail tethering soul to body */}
        <g className="sq-wisp" strokeDasharray="6 10" strokeLinecap="round" fill="none">
          <path d="M 263 472 C 255 500 292 512 289 538" stroke="url(#sq-wisp-g)" strokeWidth="3" />
          <path d="M 268 470 C 278 498 252 515 285 540" stroke="url(#sq-wisp-g)" strokeWidth="2" />
        </g>
        <g className="sq-soul-bob">
          {/* glow copy behind the figure */}
          <g filter="url(#sq-blur-m)" opacity="0.7">
            <circle cx="270" cy="330" r="26" fill="#7dd3fc" />
            <path
              d="M 270 362 Q 267 415 263 470"
              stroke="#7dd3fc"
              strokeWidth="38"
              strokeLinecap="round"
              fill="none"
            />
          </g>
          {/* figure: head, torso fading to a wisp, reaching arm, relaxed arm */}
          <circle cx="270" cy="330" r="26" fill="url(#sq-soul-g)" />
          <path
            d="M 270 362 Q 267 415 263 470"
            stroke="url(#sq-soul-g)"
            strokeWidth="38"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 280 385 Q 295 379 306 371"
            stroke="url(#sq-soul-g)"
            strokeWidth="15"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 263 395 Q 246 430 240 458"
            stroke="url(#sq-soul-g)"
            strokeWidth="13"
            strokeLinecap="round"
            fill="none"
          />
          {/* tiny sparkles around the soul */}
          <circle className="sq-star" cx="238" cy="310" r="2" style={{ "--delay": "0.4s", "--dur": "3s" } as StarVar} />
          <circle className="sq-star" cx="300" cy="292" r="1.6" style={{ "--delay": "1.4s", "--dur": "3.6s" } as StarVar} />
          <circle className="sq-star" cx="243" cy="366" r="1.4" style={{ "--delay": "2.2s", "--dur": "3.2s" } as StarVar} />
        </g>
      </g>

      {/* the star plucked off the moon's lower horn, arcing over to seed the graph */}
      <circle
        className="sq-pluck-flash"
        cx="298"
        cy="380"
        r="10"
        fill="#a5f3fc"
        filter="url(#sq-blur-m)"
      />
      <path
        className="sq-pluck-star"
        d="M 0 -7 L 1.7 -1.7 L 7 0 L 1.7 1.7 L 0 7 L -1.7 1.7 L -7 0 L -1.7 -1.7 Z"
        fill="#e0fbff"
        filter="url(#sq-blur-s)"
        style={{ offsetPath: "path('M 298 380 Q 345 305 405 346')" }}
      />

      {/* -------- bright constellation overlay: lights up when touched -------- */}
      <g>
        {EDGES.map(([a, b, wave], i) => (
          <line
            key={`bright-${i}`}
            className={`sq-edge-bright sq-edge-${wave}`}
            pathLength={1}
            x1={NODES[a][0]}
            y1={NODES[a][1]}
            x2={NODES[b][0]}
            y2={NODES[b][1]}
            stroke="url(#sq-edge-g)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        ))}
        {NODES.map(([x, y, r, wave], i) => (
          <g key={`flare-${i}`} className={`sq-flare sq-flare-${wave}`}>
            <circle cx={x} cy={y} r={r + 4} fill="#22d3ee" opacity="0.45" filter="url(#sq-blur-s)" />
            <circle cx={x} cy={y} r={r} fill="url(#sq-edge-g)" />
            <circle cx={x} cy={y} r={r * 0.45} fill="#e0fbff" />
          </g>
        ))}
      </g>

      {/* -------- insight spark returning to the sleeper -------- */}
      <circle
        className="sq-insight"
        r="4"
        fill="#a5f3fc"
        filter="url(#sq-blur-s)"
        style={{
          offsetPath:
            "path('M 405 346 Q 368 316 330 330 Q 284 350 271 392 Q 262 432 263 470 Q 262 505 312 527')",
        }}
      />
      <circle
        className="sq-headglow"
        cx="318"
        cy="528"
        r="34"
        fill="#7dd3fc"
        opacity="0"
        filter="url(#sq-blur-m)"
      />
    </svg>
  );
}
