// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectBriefCard, {
  describeBackgroundProcess,
  formatElapsed,
  useBackgroundProcesses,
} from "../ProjectBriefCard";
import type { BackgroundProcessView } from "../../api/tauri";

const apiMocks = vi.hoisted(() => ({
  configGet: vi.fn(() => Promise.resolve({ reviewEnabled: true })),
  configSet: vi.fn(),
  projectBriefGet: vi.fn(),
  backgroundProcessesList: vi.fn(() => Promise.resolve([] as BackgroundProcessView[])),
  backgroundProcessStop: vi.fn((_pid: number) => Promise.resolve([] as BackgroundProcessView[])),
}));

vi.mock("../../api/tauri", () => ({
  ...apiMocks,
  isTauri: () => true,
}));

const brief = {
  mission: "Build durable research continuity.",
  activity: null,
  intent: null,
  goal: null,
};

const devServer: BackgroundProcessView = {
  pid: 4242,
  label: "bash background: npm run dev",
  elapsedMs: 95_000,
  logPath: "F:/project/.somniq/tmp/background/1-npm-run-dev.log",
};

const adoptedSurvivor: BackgroundProcessView = {
  pid: 4243,
  label: "bash: python -m http.server & [left running by the shell]",
  elapsedMs: 4_000,
  logPath: null,
};

function renderCard(props: Partial<React.ComponentProps<typeof ProjectBriefCard>> = {}) {
  return render(
    <ProjectBriefCard
      brief={brief}
      language="cn"
      onHide={vi.fn()}
      reviewEnabled
      onReviewEnabledChange={vi.fn()}
      {...props}
    />,
  );
}

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useBackgroundProcesses>) => void }) {
  const api = useBackgroundProcesses();
  onReady(api);
  return <div data-testid="count">{api.processes.length}</div>;
}

beforeEach(() => {
  // vi.clearAllMocks() keeps implementations, so each test states its own.
  apiMocks.backgroundProcessesList.mockResolvedValue([]);
  apiMocks.backgroundProcessStop.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("background processes in the project summary", () => {
  it("lists what is running right now", async () => {
    renderCard({ backgroundProcesses: [adoptedSurvivor, devServer] });
    await act(async () => Promise.resolve());

    expect(screen.getByText("后台运行中 · 2")).toBeTruthy();
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByText("bash · 1m")).toBeTruthy();
    // The adopted marker becomes a flag instead of crowding out the command.
    expect(screen.getByText("python -m http.server &")).toBeTruthy();
    expect(screen.getByText("bash · 4s · shell 遗留")).toBeTruthy();
  });

  it("keeps the row out of the summary when nothing is running", () => {
    renderCard();

    expect(screen.queryByText(/后台运行中/)).toBeNull();
    expect(screen.getByText("Build durable research continuity.")).toBeTruthy();
  });

  it("shows running processes even before a project brief exists", () => {
    renderCard({ brief: null, backgroundProcesses: [devServer] });

    expect(screen.getByText("后台运行中 · 1")).toBeTruthy();
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.queryByText("Build durable research continuity.")).toBeNull();
  });

  it("stops a process from the row", () => {
    const onStopBackgroundProcess = vi.fn();
    renderCard({ backgroundProcesses: [devServer], onStopBackgroundProcess });

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStopBackgroundProcess).toHaveBeenCalledWith(4242);
  });

  it("disables the stop button while the stop is in flight", () => {
    renderCard({ backgroundProcesses: [devServer], stoppingBackgroundPids: [4242] });

    const button = screen.getByRole("button", { name: "停止中" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the capture file, and offers nothing when there is none", () => {
    const onOpenBackgroundLog = vi.fn();
    renderCard({
      backgroundProcesses: [devServer, adoptedSurvivor],
      onOpenBackgroundLog,
    });

    const logButtons = screen.getAllByRole("button", { name: "日志" });
    expect(logButtons).toHaveLength(1);
    fireEvent.click(logButtons[0]);
    expect(onOpenBackgroundLog).toHaveBeenCalledWith(devServer.logPath);
  });
});

describe("useBackgroundProcesses", () => {
  it("polls the backend and drops processes that exited", async () => {
    vi.useFakeTimers();
    apiMocks.backgroundProcessesList.mockResolvedValue([devServer]);
    render(<Harness onReady={() => undefined} />);
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("count").textContent).toBe("1");

    apiMocks.backgroundProcessesList.mockResolvedValue([]);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("stops polling once the summary unmounts", async () => {
    vi.useFakeTimers();
    const view = render(<Harness onReady={() => undefined} />);
    await act(async () => Promise.resolve());
    expect(apiMocks.backgroundProcessesList).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(apiMocks.backgroundProcessesList).toHaveBeenCalledTimes(1);
  });

  it("applies the list the stop call returns without waiting for the next poll", async () => {
    vi.useFakeTimers();
    apiMocks.backgroundProcessesList.mockResolvedValue([devServer, adoptedSurvivor]);
    apiMocks.backgroundProcessStop.mockResolvedValue([adoptedSurvivor]);
    let api: ReturnType<typeof useBackgroundProcesses> | null = null;
    render(<Harness onReady={(next) => { api = next; }} />);
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("count").textContent).toBe("2");

    await act(async () => {
      await api?.stop(4242);
    });

    expect(apiMocks.backgroundProcessStop).toHaveBeenCalledWith(4242);
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("keeps the entry when stopping fails, leaving the next poll to reconcile", async () => {
    vi.useFakeTimers();
    apiMocks.backgroundProcessesList.mockResolvedValue([devServer]);
    apiMocks.backgroundProcessStop.mockRejectedValue(new Error("access denied"));
    let api: ReturnType<typeof useBackgroundProcesses> | null = null;
    render(<Harness onReady={(next) => { api = next; }} />);
    await act(async () => Promise.resolve());

    await act(async () => {
      await api?.stop(4242);
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
  });
});

describe("background process labels", () => {
  it("splits the registry label into shell and command", () => {
    expect(describeBackgroundProcess("bash background: npm run dev")).toEqual({
      shell: "bash",
      command: "npm run dev",
      adopted: false,
    });
    expect(describeBackgroundProcess("serve")).toEqual({
      shell: "",
      command: "serve",
      adopted: false,
    });
  });

  it("flags a service the shell left running instead of printing the marker", () => {
    expect(
      describeBackgroundProcess("bash: npm run dev & [left running by the shell]"),
    ).toEqual({ shell: "bash", command: "npm run dev &", adopted: true });
  });

  it("formats uptime from seconds to hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(-5_000)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(59 * 60_000)).toBe("59m");
    expect(formatElapsed(3 * 3_600_000 + 25 * 60_000)).toBe("3h 25m");
  });
});
