import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  r: number;
  /** Downward drift, px per second. */
  vy: number;
  /** Twinkle phase and speed. */
  phase: number;
  speed: number;
  hue: string;
};

const DENSITY = 1 / 9000; // stars per square pixel
const MAX_STARS = 220;
const HUES = ["#ffffff", "#cfe4ff", "#7df3ff", "#b9a8ff"];

/**
 * Slow drifting starfield behind the hero — the "seek in sleep" half of the
 * brand. Canvas rather than DOM nodes so a few hundred stars cost one paint.
 *
 * Skipped entirely under `prefers-reduced-motion`, and the loop is suspended
 * while the tab is hidden so a background tab burns no frames.
 */
export default function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stars: Star[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // A zero box means the hero is not laid out yet (hidden pane, collapsed
      // window, `display: none` ancestor). Bail without seeding: the observer
      // fires again with real numbers once it has a size.
      if (width < 1 || height < 1) {
        stars = [];
        return;
      }
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(MAX_STARS, Math.round(width * height * DENSITY));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.25 + 0.35,
        vy: Math.random() * 5 + 1.5,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 1.6 + 0.5,
        hue: HUES[Math.floor(Math.random() * HUES.length)],
      }));
    };

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);

      for (const star of stars) {
        star.y += star.vy * dt;
        if (star.y > height + 2) {
          star.y = -2;
          star.x = Math.random() * width;
        }
        star.phase += star.speed * dt;
        // Fade stars out toward the bottom so they never collide with the copy.
        const depth = 1 - star.y / height;
        const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(star.phase));

        ctx.globalAlpha = Math.max(0, twinkle * depth * 0.85);
        ctx.fillStyle = star.hue;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };

    const start = () => {
      last = performance.now();
      frame = requestAnimationFrame(draw);
    };
    const stop = () => cancelAnimationFrame(frame);

    const onVisibility = () => (document.hidden ? stop() : start());

    resize();
    start();
    // Observe the element, not the window: a window-resize listener never fires
    // when the canvas goes from zero to a real size because an ancestor was
    // laid out late, which would leave the starfield permanently blank.
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="starfield" aria-hidden="true" />;
}
