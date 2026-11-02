// Offline Arabic name suggestions for customers, suppliers, employees and projects.
import { describe, it, expect } from 'vitest';
import { suggestArabicName, transliterate } from '../src/books/arabicName.js';

describe('Arabic name suggestion', () => {
  it.each([
    ['Riyadh Supplies Co', 'شركة الرياض للتوريدات'],
    ['Marina Café LLC', 'مقهى المارينا ذ.م.م'],
    ['Al Noor Trading', 'النور للتجارة'],
    ['Al Faisal Contracting', 'الفيصل للمقاولات'],
    ['Najd Wholesale', 'نجد للجملة'],
    ['Desert Telecom', 'الصحراء للاتصالات'],
    ['Gulf Steel Trading', 'الخليج للحديد والتجارة'],
    ['Red Sea Hotel', 'فندق البحر الأحمر'],
    ['Mohammed Al Otaibi', 'محمد العتيبي'],
    ['Al-Rajhi Est. for Trading and Contracting', 'مؤسسة الراجحي للتجارة والمقاولات'],
  ])('%s -> %s', (en, ar) => {
    expect(suggestArabicName(en)).toBe(ar);
  });

  it('spells unknown words letter by letter, and gives nothing for an empty name', () => {
    expect(transliterate('Zain')).toBe('زاين');
    expect(suggestArabicName('Bayt Zain Stores')).toBe('متاجر بايت زاين');
    expect(suggestArabicName('   ')).toBe('');
  });
});
