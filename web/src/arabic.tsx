// Fills Arabic names in automatically from the English name, without overwriting what a person typed.
import { suggestArabicName } from '../../src/books/arabicName.ts';
import { useI18n } from './i18n.tsx';

/** New Arabic name after the English name changes: follow the suggestion unless the person edited it. */
export function followArabic(oldEnglish: string, newEnglish: string, currentArabic: string): string {
  const untouched = !currentArabic.trim() || currentArabic === suggestArabicName(oldEnglish);
  return untouched ? suggestArabicName(newEnglish) : currentArabic;
}

export function ArabicHint({ english, arabic }: { english: string; arabic: string }) {
  const { t } = useI18n();
  if (!arabic || arabic !== suggestArabicName(english)) return null;
  return <span className="small mut">{t('ar.suggested')}</span>;
}
