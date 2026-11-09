import { useCallback, useEffect, useState } from "react";
import { chatAgentInterrupt, chatAgentList, onChatAgentActivity, onChatAgents, type AgentTaskCard } from "../api/agentTasks";

type Snapshot = { scope: string; agents: AgentTaskCard[]; error: string };

function mergeAgents(previous: AgentTaskCard[], incoming: AgentTaskCard[], keepEqualRevision = false): AgentTaskCard[] {
  const items = new Map(previous.map(agent => [agent.sessionId, agent]));
  for (const agent of incoming) {
    const existing = items.get(agent.sessionId);
    if (!existing || (agent.revision ?? 0) > (existing.revision ?? 0)
      || (!keepEqualRevision && (agent.revision ?? 0) === (existing.revision ?? 0))) items.set(agent.sessionId, agent);
  }
  return [...items.values()];
}

/** Keep observing the controller even while the summary or a child tab is hidden. */
export function useAgentTasks(sessionId: string, projectId: string | undefined, busy: boolean, enabled: boolean) {
  const scope = JSON.stringify([projectId, sessionId]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ scope, agents: [], error: "" });
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let live = true;
    const accept = (agents: AgentTaskCard[], keepEqualRevision = false) => {
      if (!live) return;
      setSnapshot(previous => ({ scope, agents: mergeAgents(previous.scope === scope ? previous.agents : [], agents, keepEqualRevision), error: "" }));
    };
    const subscriptions = [
      onChatAgents(event => {
        if (event.sessionId === sessionId) accept(event.agents);
      }),
      onChatAgentActivity(event => {
        if (!live || event.sessionId !== sessionId) return;
        setSnapshot(previous => previous.scope !== scope ? previous : {
          ...previous,
          agents: previous.agents.map(agent => agent.sessionId === event.childSessionId && (event.revision ?? 0) >= (agent.revision ?? 0)
            ? { ...agent, lastActivity: event.activity, revision: event.revision } : agent),
        });
      }),
    ];
    void Promise.all(subscriptions).then(() => live ? chatAgentList(sessionId, projectId) : []).then(agents => accept(agents, true)).catch(reason => {
      if (live) setSnapshot(previous => ({ scope, agents: previous.scope === scope ? previous.agents : [], error: String(reason) }));
    });
    return () => {
      live = false;
      for (const subscription of subscriptions) void subscription.then(stop => stop()).catch(() => undefined);
    };
  }, [sessionId, projectId, scope, busy, enabled]);

  const stop = useCallback(async (agent: AgentTaskCard) => {
    setStopping(agent.sessionId);
    try {
      await chatAgentInterrupt(sessionId, projectId, agent.path);
      const agents = await chatAgentList(sessionId, projectId);
      setSnapshot(previous => previous.scope !== scope ? previous : { scope, agents: mergeAgents(previous.agents, agents), error: "" });
    } catch (reason) {
      setSnapshot(previous => previous.scope !== scope ? previous : { ...previous, error: String(reason) });
    } finally {
      setStopping(current => current === agent.sessionId ? null : current);
    }
  }, [sessionId, projectId, scope]);

  return {
    agents: enabled && snapshot.scope === scope ? snapshot.agents : [],
    error: enabled && snapshot.scope === scope ? snapshot.error : "",
    stopping,
    stop,
  };
}
