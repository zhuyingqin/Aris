/**
 * The editor's own settings surface — Overleaf keeps the same knobs in its left
 * menu (`editor-left-menu`). Everything here writes straight through to the
 * module-level store in `editorSettings.ts`, and every live CodeMirror view
 * reconfigures itself from that store, so there is no "apply" step and no
 * editor rebuild.
 */
import type { RefObject } from "react";
import {
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_SIZES,
  EDITOR_KEYBINDINGS,
  EDITOR_LINE_HEIGHTS,
  EDITOR_SPELL_LANGUAGES,
  setEditorSettings,
  type EditorFontFamily,
  type EditorKeybindings,
  type EditorLineHeight,
} from "../editor/editorSettings";
import { useEditorSettings } from "../editor/useEditorSettings";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { ToolIcon } from "./ToolIcon";
import { TypesetPopover, type PopoverAlign, type PopoverSide } from "./TypesetPopover";

export default function TypesetEditorSettings({
  open,
  anchorRef,
  side = "right",
  align = "end",
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  side?: PopoverSide;
  align?: PopoverAlign;
  onClose: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].editorSettings;
  const settings = useEditorSettings();

  const toggle = (
    key: "autoComplete" | "autoCloseBrackets" | "codeCheck" | "indentMarkers",
    label: string,
    hint: string,
  ) => (
    <label className="typeset-editor-settings-row typeset-editor-settings-toggle">
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(event) => setEditorSettings({ [key]: event.currentTarget.checked })}
      />
      <span>
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
    </label>
  );

  return (
    <TypesetPopover
      open={open}
      anchorRef={anchorRef}
      side={side}
      align={align}
      width={288}
      className="typeset-editor-settings"
      label={copy.title}
      onClose={onClose}
    >
      <div className="typeset-editor-settings-head">
        <strong>{copy.title}</strong>
        <button type="button" title={copy.close} aria-label={copy.close} onClick={onClose}>
          <ToolIcon name="clear" />
        </button>
      </div>

      <div className="typeset-editor-settings-body">
        <label className="typeset-editor-settings-row">
          <span>{copy.fontFamily}</span>
          <select
            value={settings.fontFamily}
            onChange={(event) => setEditorSettings({ fontFamily: event.currentTarget.value as EditorFontFamily })}
          >
            {EDITOR_FONT_FAMILIES.map((value) => (
              <option key={value} value={value}>{copy.fontFamilyLabel(value)}</option>
            ))}
          </select>
        </label>

        <label className="typeset-editor-settings-row">
          <span>{copy.fontSize}</span>
          <select
            value={settings.fontSize}
            onChange={(event) => setEditorSettings({ fontSize: Number(event.currentTarget.value) })}
          >
            {EDITOR_FONT_SIZES.map((value) => (
              <option key={value} value={value}>{value}px</option>
            ))}
          </select>
        </label>

        <label className="typeset-editor-settings-row">
          <span>{copy.lineHeight}</span>
          <select
            value={settings.lineHeight}
            onChange={(event) => setEditorSettings({ lineHeight: event.currentTarget.value as EditorLineHeight })}
          >
            {EDITOR_LINE_HEIGHTS.map((value) => (
              <option key={value} value={value}>{copy.lineHeightLabel(value)}</option>
            ))}
          </select>
        </label>

        <label className="typeset-editor-settings-row">
          <span>{copy.keybindings}</span>
          <select
            value={settings.keybindings}
            onChange={(event) => setEditorSettings({ keybindings: event.currentTarget.value as EditorKeybindings })}
          >
            {EDITOR_KEYBINDINGS.map((value) => (
              <option key={value} value={value}>{copy.keybindingsLabel(value)}</option>
            ))}
          </select>
        </label>

        <label className="typeset-editor-settings-row">
          <span>{copy.spellCheckLanguage}</span>
          <select
            value={settings.spellCheckLanguage}
            onChange={(event) => setEditorSettings({ spellCheckLanguage: event.currentTarget.value })}
          >
            {EDITOR_SPELL_LANGUAGES.map((value) => (
              <option key={value} value={value}>{value === "off" ? copy.spellCheckOff : value}</option>
            ))}
          </select>
        </label>

        <hr />

        {toggle("autoComplete", copy.autoComplete, copy.autoCompleteHint)}
        {toggle("autoCloseBrackets", copy.autoCloseBrackets, copy.autoCloseBracketsHint)}
        {toggle("codeCheck", copy.codeCheck, copy.codeCheckHint)}
        {toggle("indentMarkers", copy.indentMarkers, copy.indentMarkersHint)}
      </div>

      <p className="typeset-editor-settings-foot">{copy.scopeNote}</p>
    </TypesetPopover>
  );
}
