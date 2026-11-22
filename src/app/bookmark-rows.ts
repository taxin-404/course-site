import type { CourseData, Lesson } from './api';

export interface BookmarkRow {
  lesson: string;
  title: string;
  kind: Lesson['kind'];
  course: string;
  section: string;
  bookmarkedAt: number;
}

const NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The bookmarks page rows: every bookmarked lesson the user can currently see, newest first. */
export function bookmarkRows(courses: CourseData[]): BookmarkRow[] {
  const rows: BookmarkRow[] = [];
  for (const course of courses) {
    for (const section of course.sections) {
      for (const lesson of section.lessons) {
        if (!lesson.bookmarked) continue;
        rows.push({
          lesson: lesson.id,
          title: lesson.title,
          kind: lesson.kind,
          course: course.title,
          section: section.title || '',
          bookmarkedAt: lesson.bookmarkedAt || 0,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    b.bookmarkedAt - a.bookmarkedAt ||
    NAME.compare(a.course, b.course) ||
    NAME.compare(a.section, b.section) ||
    NAME.compare(a.title, b.title) ||
    NAME.compare(a.lesson, b.lesson));
}
