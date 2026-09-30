import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import LibraryActionMenu, { type LibraryMenuAction } from "./LibraryActionMenu";

export default function LiteratureBatchBar({
  count, isTrashView, currentCollectionId, onShortlist, onExclude, onDownload,
  onDelete, onRestore, onPermanentDelete, onMerge, onRemoveFromCollection,
  onQuickCopy, onReport, onClear,
}: {
  count: number;
  isTrashView: boolean;
  currentCollectionId?: string;
  onShortlist: () => void;
  onExclude: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
  onMerge: () => void;
  onRemoveFromCollection: () => void;
  onQuickCopy: () => void;
  onReport: () => void;
  onClear: () => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  if (!count) return null;
  const actions: LibraryMenuAction[] = [
    { id: "exclude", label: copy.table.exclude, onSelect: onExclude },
    { id: "report", label: copy.table.report, onSelect: onReport },
    ...(count === 2 ? [{ id: "merge", label: copy.table.mergeDuplicates, onSelect: onMerge }] : []),
    ...(currentCollectionId ? [{ id: "remove", label: copy.table.removeFromCollection, onSelect: onRemoveFromCollection }] : []),
    { id: "delete", label: copy.table.delete, icon: "trash", danger: true, onSelect: onDelete },
  ];
  return (
    <div className="lit-batch-bar" role="toolbar" aria-label={copy.table.batchActionsAria}>
      <span className="lit-batch-count" aria-live="polite">{copy.table.selectedCount(count)}</span>
      {isTrashView ? <>
        <button type="button" onClick={onRestore}>{copy.table.restore}</button>
        <button type="button" className="danger" onClick={onPermanentDelete}>{copy.table.permanentlyDelete}</button>
      </> : <>
        <button type="button" onClick={onShortlist}>{copy.table.shortlist}</button>
        <button type="button" onClick={onDownload}>{copy.table.downloadPdf}</button>
        <button type="button" onClick={onQuickCopy}>{copy.table.quickCopy}</button>
        <LibraryActionMenu label={copy.libraryUi.moreActions} actions={actions} />
      </>}
      <button type="button" className="lit-batch-clear" onClick={onClear} aria-label={copy.table.clear} title={copy.table.clear}><SvgIcon name="close" size={14} /></button>
    </div>
  );
}
