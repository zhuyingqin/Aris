import { useState } from "react";
import type { Copy } from "../i18n";
import Section from "./Section";

type Props = { copy: Copy };

export default function Skills({ copy }: Props) {
  const { skills } = copy;
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = (cmd: string, index: number) => {
    navigator.clipboard.writeText(cmd).catch(() => {});
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <Section
      id="skills"
      kicker={skills.kicker}
      title={skills.title}
      lede={skills.lede}
      tone="raised"
    >
      <div className="skills-layout">
        <figure className="terminal" data-reveal>
          <figcaption className="terminal-bar">
            <div className="terminal-dots">
              <span className="terminal-dot" />
              <span className="terminal-dot" />
              <span className="terminal-dot" />
            </div>
            <span className="terminal-title">{skills.exampleTitle}</span>
            <span className="terminal-badge">SomniQ CLI & Workspace</span>
          </figcaption>
          <pre className="terminal-body">
            {skills.examples.map((ex, i) => (
              <div key={ex.command} className="terminal-line-group">
                <span className="terminal-comment"># {ex.comment}</span>
                <div className="terminal-cmd-row">
                  <span className="terminal-prompt">❯ </span>
                  <span className="terminal-command">{ex.command}</span>
                  <button
                    type="button"
                    className="terminal-copy-btn"
                    onClick={() => handleCopy(ex.command, i)}
                    title={skills.copyBtn.copyTitle}
                  >
                    {copiedIndex === i ? skills.copyBtn.copied : skills.copyBtn.copy}
                  </button>
                </div>
              </div>
            ))}
          </pre>
        </figure>

        <ul className="skill-groups" data-reveal>
          {skills.groups.map((group) => (
            <li key={group.name} className="skill-group">
              <h3>{group.name}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item} className="skill-item">
                    <code>{item}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
