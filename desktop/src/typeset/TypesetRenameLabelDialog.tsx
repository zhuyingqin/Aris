import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invalidLabelName, labelSites } from "../editor/latexNavigation";
import { tr, type Language } from "../language";

/**
 * F2 on a label: one name, changed in its `\label` and every `\ref` across the
 * document. Shows how many places in how many files before anything changes.
 */
export default function TypesetRenameLabelDialog({
  name,
  sources,
  language,
  onCancel,
  onRename,
}: {
  name: string;
  /** Every file of the document as [path, text], the open one live. */
  sources: [string, string][];
  language: Language;
  onCancel: () => void;
  onRename: (to: string) => Promise<{ files: number; places: number }>;
}) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { files, places, existing } = useMemo(() => {
    let fileCount = 0;
    let placeCount = 0;
    const names = new Set<string>();
    for (const [, source] of sources) {
      const sites = labelSites(source);
      const own = sites.filter((site) => site.name === name);
      if (own.length > 0) fileCount += 1;
      placeCount += own.length;
      for (const site of sites) if (site.kind === "definition") names.add(site.name);
    }
    return { files: fileCount, places: placeCount, existing: names };
  }, [name, sources]);
  const next = value.trim();
  const invalid = invalidLabelName(next);
  const taken = next !== name && existing.has(next);
  const problem = invalid === "characters"
    ? t("标签名不能包含空格、逗号、花括号、% 、# 或反斜杠。", "A label cannot contain spaces, commas, braces, %, # or backslashes.", "Una etiqueta no puede contener espacios, comas, llaves, %, # ni barras invertidas.")
    : taken
      ? t(`文档里已经有标签“${next}”，改名会让两个标签重名。`, `The document already defines "${next}"; renaming would duplicate it.`, `El documento ya define «${next}»; renombrar la duplicaría.`)
      : null;

  const submit = async () => {
    if (invalid || taken || next === name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="typeset-file-dialog-backdrop" role="presentation" onMouseDown={(event) => event.stopPropagation()}>
      <form
        className="typeset-file-dialog typeset-rename-label-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="typeset-rename-label-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 id="typeset-rename-label-title">{t("重命名标签", "Rename label", "Renombrar etiqueta")}</h3>
        <p className="typeset-rename-label-scope">
          {t(
            `“${name}”在 ${files} 个文件中出现 ${places} 处（\\label 与所有引用），都会一起改。`,
            `"${name}" appears ${places} times in ${files} files (its \\label and every reference); all of them change.`,
            `«${name}» aparece ${places} veces en ${files} archivos (su \\label y todas las referencias); todas cambian.`,
          )}
        </p>
        <label>
          {t("新标签名", "New name", "Nuevo nombre")}
          <input
            autoFocus
            value={value}
            disabled={busy}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {(problem || error) && <p className="typeset-rename-label-problem" role="alert">{error ?? problem}</p>}
        <div className="typeset-file-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>{t("取消", "Cancel", "Cancelar")}</button>
          <button type="submit" className="primary" disabled={busy || Boolean(invalid) || taken || next === name}>
            {t("重命名", "Rename", "Renombrar")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
