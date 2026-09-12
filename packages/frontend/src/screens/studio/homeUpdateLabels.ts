/** Home, team and space counts group unread activity by destination. */
export function unreadUpdatesDescription(count: number): string {
  return `${count} unread ${count === 1 ? "update" : "updates"}`;
}
