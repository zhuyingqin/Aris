import { useEffect, useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import {
  SEARCH_FIELD_OPTIONS,
  SEARCH_OPERATOR_OPTIONS,
  type LiteratureSearchField,
  type LiteratureSearchOperator,
} from "./advancedSearch";
import type { LiteratureSearchCondition } from "./literatureTypes";

const makeCondition = (index: number): LiteratureSearchCondition => ({
  id: "condition-" + Date.now().toString(36) + "-" + index,
  conditionIndex: index,
  field: "any",
  operator: "contains",
  value: "",
  ...(index > 0 ? { joiner: "AND" } : {}),
});

export default function AdvancedSearchBuilder({
  conditions,
  onChange,
  onSave,
  onClose,
  initialName,
}: {
  conditions: LiteratureSearchCondition[];
  onChange: (conditions: LiteratureSearchCondition[]) => void;
  onSave: (conditions: LiteratureSearchCondition[], name: string) => void;
  onClose: () => void;
  initialName?: string;
}) {
  const language = useStore((state) => state.language);
  const copy = LITERATURE_COPY[language];
  const [name, setName] = useState(initialName ?? "");
  const rows = conditions.length > 0 ? conditions : [makeCondition(0)];

  useEffect(() => {
    if (conditions.length === 0) onChange(rows);
    // The parent owns the draft. This effect only creates the first row when
    // the panel is opened, and intentionally does not reset user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (index: number, patch: Partial<LiteratureSearchCondition>) => {
    onChange(rows.map((condition, rowIndex) => (
      rowIndex === index
        ? { ...condition, ...patch, conditionIndex: rowIndex }
        : { ...condition, conditionIndex: rowIndex }
    )));
  };

  const remove = (index: number) => {
    const next = rows.filter((_, rowIndex) => rowIndex !== index).map((condition, rowIndex) => ({
      ...condition,
      conditionIndex: rowIndex,
      ...(rowIndex === 0 ? { joiner: undefined } : {}),
    }));
    onChange(next.length > 0 ? next : [makeCondition(0)]);
  };

  const add = () => onChange([...rows, makeCondition(rows.length)]);

  return (
    <section className="lit-advanced-search" aria-label={copy.advancedSearch.title}>
      <header className="lit-advanced-search-head">
        <div>
          <strong>{copy.advancedSearch.title}</strong>
          <small>{copy.advancedSearch.hint}</small>
        </div>
        <button type="button" className="lit-icon-button" onClick={onClose} aria-label={copy.advancedSearch.close}>
          <SvgIcon name="close" size={14} />
        </button>
      </header>
      <div className="lit-advanced-search-rows">
        {rows.map((condition, index) => {
          const emptyOperator = condition.operator === "isEmpty" || condition.operator === "isNotEmpty";
          return (
            <div className="lit-advanced-search-row" key={condition.id}>
              {index > 0 ? (
                <select
                  className="lit-advanced-search-joiner"
                  value={condition.joiner === "OR" ? "OR" : "AND"}
                  aria-label={copy.advancedSearch.joiner}
                  onChange={(event) => update(index, { joiner: event.target.value })}
                >
                  <option value="AND">{copy.advancedSearch.and}</option>
                  <option value="OR">{copy.advancedSearch.or}</option>
                </select>
              ) : <span className="lit-advanced-search-joiner-placeholder" />}
              <select
                value={condition.field}
                aria-label={copy.advancedSearch.field}
                onChange={(event) => update(index, { field: event.target.value as LiteratureSearchField })}
              >
                {SEARCH_FIELD_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {language === "cn" ? option.labelCn : option.labelEn}
                  </option>
                ))}
              </select>
              <select
                value={condition.operator}
                aria-label={copy.advancedSearch.operator}
                onChange={(event) => update(index, { operator: event.target.value as LiteratureSearchOperator })}
              >
                {SEARCH_OPERATOR_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {language === "cn" ? option.labelCn : option.labelEn}
                  </option>
                ))}
              </select>
              <input
                value={condition.value}
                disabled={emptyOperator}
                aria-label={copy.advancedSearch.value}
                placeholder={emptyOperator ? copy.advancedSearch.noValue : copy.advancedSearch.valuePlaceholder}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <button
                type="button"
                className="lit-icon-button"
                onClick={() => remove(index)}
                aria-label={copy.advancedSearch.removeCondition}
                title={copy.advancedSearch.removeCondition}
              >
                <SvgIcon name="close" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="lit-advanced-search-actions">
        <button type="button" onClick={add}><SvgIcon name="plus" size={13} />{copy.advancedSearch.addCondition}</button>
        <button type="button" onClick={() => onChange([makeCondition(0)])}>{copy.advancedSearch.reset}</button>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={copy.advancedSearch.namePlaceholder}
          aria-label={copy.advancedSearch.name}
        />
        <button type="button" className="primary" onClick={() => onSave(rows, name.trim())}>
          <SvgIcon name="check" size={13} />{copy.advancedSearch.save}
        </button>
      </div>
    </section>
  );
}
