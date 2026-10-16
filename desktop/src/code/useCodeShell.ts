import { useEffect, useRef, useState } from "react";
import {
  codeBridgeConnected, codeBridgeSetShell, onCodeBridgeConnection,
  onCodeBridgeShellAction, onCodeBridgeShellReady,
} from "../api/tauri";
import type { CodeShellAction, CodeShellState } from "./codeShell";

interface Options {
  enabled: boolean;
  active: boolean;
  shell: CodeShellState;
  onSelectModule: (id: string) => void;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onRevealProject: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}

/** Keep the desktop header until the authenticated editor applies our controls. */
export function useCodeShell(options: Options): boolean {
  const latest = useRef(options);
  latest.current = options;
  const revision = useRef(0);
  const connectedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [listening, setListening] = useState(false);
  const [ready, setReady] = useState(false);
  const snapshot = JSON.stringify(options.shell);

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;
    let connectionEvents = 0;
    const unlisteners: (() => void)[] = [];
    const updateConnection = (value: boolean) => {
      if (disposed) return;
      connectionEvents += 1;
      connectedRef.current = value;
      setConnected(value);
      setConnectionRevision((previous) => previous + 1);
      setReady(false);
      revision.current += 1;
    };
    const act = (action: CodeShellAction) => {
      const current = latest.current;
      if (disposed || !connectedRef.current || !current.active) return;
      switch (action.kind) {
        case "select-module":
          if (current.shell.modules.some((item) => item.id === action.id)) current.onSelectModule(action.id);
          break;
        case "select-project":
          if (!current.shell.projectBusy && current.shell.projects.some((item) => item.id === action.id)) current.onSelectProject(action.id);
          break;
        case "add-project":
          if (!current.shell.projectBusy) current.onAddProject();
          break;
        case "reveal-project": current.onRevealProject(); break;
        case "settings": current.onSettings(); break;
        case "sign-out": current.onSignOut(); break;
      }
    };
    const registrations = [
      onCodeBridgeConnection(updateConnection),
      onCodeBridgeShellAction(act),
      onCodeBridgeShellReady((applied) => {
        if (!disposed && connectedRef.current && applied === revision.current) setReady(true);
      }),
    ].map(async (pending) => {
      const unlisten = await pending;
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void Promise.all(registrations).then(async () => {
      if (disposed) return;
      setListening(true);
      const observed = connectionEvents;
      const value = await codeBridgeConnected();
      if (!disposed && observed === connectionEvents) updateConnection(value);
    }).catch(() => {
      if (!disposed) setReady(false);
    });
    return () => {
      disposed = true;
      connectedRef.current = false;
      revision.current += 1;
      for (const unlisten of unlisteners) unlisten();
      setListening(false);
      setConnected(false);
      setReady(false);
    };
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled || !listening || !connected) return;
    const nextRevision = ++revision.current;
    let disposed = false;
    void codeBridgeSetShell(nextRevision, JSON.parse(snapshot) as CodeShellState)
      .then((delivered) => {
        if (!disposed && !delivered) setReady(false);
      })
      .catch(() => { if (!disposed) setReady(false); });
    return () => { disposed = true; };
  }, [connected, connectionRevision, listening, options.enabled, snapshot]);

  return options.enabled && connected && ready;
}
