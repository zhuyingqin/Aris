import { useEffect, useState } from "react";
import { isTauri, scheduledTasksList } from "../api/tauri";
import { useStore } from "../store";
import type { ScheduledTask } from "../types";

function Row({ task }: { task: ScheduledTask }) {
  const paused = task.status === "paused";
  const idShort = task.id ? (task.id.length > 20 ? `${task.id.slice(0, 20)}…` : task.id) : "";
  return (
    <div className="sched-row">
      <span className={`sched-dot${paused ? " paused" : " active"}`} aria-hidden="true" />
      <div className="sched-row-main">
        <span className="sched-row-title">{task.title || "(未命名任务)"}</span>
        {task.scheduleLabel && <span className="sched-row-schedule">{task.scheduleLabel}</span>}
        {idShort && <span className="sched-row-id">{idShort}</span>}
      </div>
      <span className={`sched-badge${paused ? " paused" : " active"}`}>{paused ? "已暂停" : "运行中"}</span>
    </div>
  );
}

function Section({ label, tasks }: { label: string; tasks: ScheduledTask[] }) {
  return (
    <section className="sched-section">
      <div className="sched-section-label">{label}</div>
      <div className="sched-list">
        {tasks.map((task) => (
          <Row key={task.id || task.title} task={task} />
        ))}
      </div>
    </section>
  );
}

export default function ScheduledTasks() {
  const setTab = useStore((s) => s.setTab);
  const setError = useStore((s) => s.setError);
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setTasks([]);
      return;
    }
    scheduledTasksList()
      .then(setTasks)
      .catch((error) => {
        setError(String(error));
        setTasks([]);
      });
  }, [setError]);

  const active = (tasks ?? []).filter((task) => task.status !== "paused");
  const paused = (tasks ?? []).filter((task) => task.status === "paused");

  return (
    <div className="sched-page">
      <div className="sched-head">
        <button className="sched-back" onClick={() => setTab("chat")} type="button">← 返回对话</button>
        <h1 className="sched-title">定时任务</h1>
        <p className="sched-sub">展示当前已创建的定时任务。在对话中让 Aris 按计划执行任务即可创建。</p>
      </div>

      {tasks === null ? (
        <div className="sched-empty">加载中…</div>
      ) : tasks.length === 0 ? (
        <div className="sched-empty">
          <div className="sched-empty-title">暂无定时任务</div>
          <div className="sched-empty-hint">在对话中让 Aris 定期执行某项任务，创建后会显示在这里。</div>
        </div>
      ) : (
        <div className="sched-body">
          {active.length > 0 && <Section label="运行中" tasks={active} />}
          {paused.length > 0 && <Section label="已暂停" tasks={paused} />}
        </div>
      )}
    </div>
  );
}
