import type { Language } from "../store";

/**
 * Plain-language explanations for the backend errors a scheduled task can
 * actually run into.
 *
 * The backend reports failures as English sentences, which the page used to
 * show only as a hover title under "Last run failed". A user who saw that
 * could not tell "install Git" from "the folder moved". Each known failure is
 * matched by a stable phrase of the backend's message and explained in the
 * user's language; anything unrecognised is shown exactly as sent, so no
 * detail is ever hidden behind a paraphrase.
 */
const KNOWN_ERRORS: ReadonlyArray<{ phrase: RegExp; cn: string; en: string }> = [
  {
    phrase: /Git is not installed or is not available on PATH/i,
    cn: "这台电脑没有安装 Git。定时任务和待办任务会先在隔离副本里修改，你确认后才写回项目，这一步需要 Git。请安装 Git（https://git-scm.com）后重试。",
    en: "Git is not installed. Scheduled and work tasks make their changes in an isolated copy and write them back only after you accept, which needs Git. Install Git (https://git-scm.com) and try again.",
  },
  {
    // Written by builds before 0.4.87 into the delivery history and lastError.
    phrase: /work tasks need a Git repository/i,
    cn: "旧版本只能在 Git 仓库里运行定时任务，这次运行因此没有执行。新版本已支持普通文件夹，下次触发会正常运行。",
    en: "Older versions could only run scheduled tasks in a Git repository, so this run did not happen. Plain folders are supported now, and the next run will go ahead.",
  },
  {
    phrase: /too large to copy into an isolated task checkout/i,
    cn: "项目文件夹太大，无法复制成隔离副本：去掉缓存和超过 50 MB 的文件后，仍超过 5 万个文件或 2 GB。请把大体量数据移出项目文件夹，或把项目设为 Git 仓库。",
    en: "The project folder is too large to copy into an isolated checkout: over 50,000 files or 2 GB remain after leaving out caches and files over 50 MB. Move bulky data out of the folder, or make the project a Git repository.",
  },
  {
    phrase: /not in SomniQ's project list/i,
    cn: "任务所属的项目已不在 SomniQ 的项目列表里，没有地方可以运行。请重新添加该项目，或把任务改到其他项目。",
    en: "The task's project is no longer in SomniQ's project list, so there is nowhere to run it. Add the project again, or point the task at another project.",
  },
  {
    phrase: /the project folder does not exist/i,
    cn: "项目文件夹不存在了，可能已被移动或删除。",
    en: "The project folder no longer exists; it may have been moved or deleted.",
  },
  {
    phrase: /waiting for work task \S+ \([^)]*\) to finish before the next run/i,
    cn: "上一次运行还没结束，这次触发会等它完成后再执行。",
    en: "The previous run has not finished yet; this one will start once it does.",
  },
];

export function describeScheduledError(raw: string | null | undefined, language: Language): string {
  const message = (raw ?? "").trim();
  if (!message) return "";
  const known = KNOWN_ERRORS.find((entry) => entry.phrase.test(message));
  return known ? known[language] : message;
}
