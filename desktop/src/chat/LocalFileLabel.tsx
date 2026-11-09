import { displayLocalFilePath } from "./localFileLinks";

/** Keep the filename visible even when its directory is too long to fit. */
export default function LocalFileLabel({ path }: { path: string }) {
  const displayPath = displayLocalFilePath(path);
  const lastSlash = displayPath.lastIndexOf("/");
  const name = displayPath.slice(lastSlash + 1) || displayPath;
  const directory = lastSlash >= 0 ? displayPath.slice(0, lastSlash + 1) : "";

  return (
    <span className="chat-file-label">
      <span className="chat-file-label-name">{name}</span>
      {directory && <span className="chat-file-label-directory">{directory}</span>}
    </span>
  );
}
