export function toBaseLang(locale: string | undefined): string | undefined {
  return locale?.split('-')[0];
}
