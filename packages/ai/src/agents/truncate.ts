/** Caps a string at `max` characters, appending `marker` when it overflows. */
export function truncateWithMarker(
  content: string,
  max: number,
  marker: string,
): string {
  if (content.length <= max) {
    return content;
  }
  return content.slice(0, max) + marker;
}
