import type { Copy } from "../i18n";
import { RELEASES_URL } from "../i18n";
import { ArrowIcon, WindowsIcon } from "./icons";
import Starfield from "./Starfield";
import AppMock from "./AppMock";
import { usePointerGlow } from "../usePointerGlow";

type Props = { copy: Copy };

export default function Hero({ copy }: Props) {
  const glowRef = usePointerGlow<HTMLElement>();

  return (
    <section className="hero" ref={glowRef}>
      <Starfield />
      <span className="hero-spotlight" aria-hidden="true" />

      <div className="container">
        <div className="hero-copy" data-reveal>
          <p className="hero-eyebrow">
            <img src="./app-logo.png" alt="SomniQ Logo" width={20} height={20} className="hero-eyebrow-logo" />
            {copy.hero.eyebrow}
          </p>

          <h1 className="hero-title">
            {copy.hero.title.split("\n").map((line, i, all) => (
              <span key={i}>{i < all.length - 1 ? `${line} ` : line}</span>
            ))}
          </h1>

          <div className="hero-cta">
            <a
              className="btn btn--primary"
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              <WindowsIcon width={17} height={17} />
              {copy.hero.ctaPrimary}
              <ArrowIcon className="btn-arrow" width={17} height={17} />
            </a>
            <a
              className="btn btn--ghost"
              href="#does"
            >
              {copy.hero.ctaSecondary}
            </a>
          </div>

          <ul className="hero-chips">
            {copy.hero.chips.map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        </div>

        {/* 1:1 Live Desktop Workspace Interactive Showcase */}
        <div className="hero-visual" data-reveal>
          <AppMock copy={copy} />
        </div>
      </div>
    </section>
  );
}
