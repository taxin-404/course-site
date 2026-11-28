/**
 * A lesson's path is its id, so two videos in one folder may share the title "Live Class"
 * only because the server gives the second one an invisible ordinal at the end of the id.
 * This is the title people see; it is the only thing the admin screens should display,
 * compare or show in a hint.
 */
export function lessonName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1).replace(/\u200B\d+$/, '');
}