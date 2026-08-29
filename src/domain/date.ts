export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
