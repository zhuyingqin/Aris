import type { GuideLesson, GuideLessonEntry, LessonReview } from "./paperReadingApi";

/** The lesson a reader sees: an accepted revision replaces the first draft. */
export const currentLesson = (entry: GuideLessonEntry): GuideLesson | null =>
  entry.revision?.result ?? entry.task.result;

/** The review that applies to the lesson returned by `currentLesson`. */
export const finalReview = (entry: GuideLessonEntry): LessonReview | null => {
  const round = entry.revision?.result ? 1 : 0;
  const reviews = entry.reviews ?? [];
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    if (reviews[index].round === round) return reviews[index];
  }
  return null;
};
