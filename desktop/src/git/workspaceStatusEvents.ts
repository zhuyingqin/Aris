import type { GitWorkspaceSnapshot } from "../api/tauri";

const GIT_WORKSPACE_STATUS_EVENT = "somniq:git-workspace-status";

export function publishGitWorkspaceStatus(snapshot: GitWorkspaceSnapshot) {
  window.dispatchEvent(new CustomEvent(GIT_WORKSPACE_STATUS_EVENT, { detail: snapshot }));
}

export function subscribeGitWorkspaceStatus(handler: (snapshot: GitWorkspaceSnapshot) => void) {
  const listener = (event: Event) => {
    handler((event as CustomEvent<GitWorkspaceSnapshot>).detail);
  };
  window.addEventListener(GIT_WORKSPACE_STATUS_EVENT, listener);
  return () => window.removeEventListener(GIT_WORKSPACE_STATUS_EVENT, listener);
}
