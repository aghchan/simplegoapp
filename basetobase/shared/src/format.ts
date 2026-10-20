export function formatDuration(ms: number): string {
  const totalSeconds = ms > 0 ? Math.floor(ms / 1000) : 0;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${twoDigits(totalSeconds % 60)}s`;
  }
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${Math.floor(totalSeconds / 3600)}h ${twoDigits(minutes)}m`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
