import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { fmt, toMinor, fromMinor } from '../money.ts';
import { ErrorNote, Loading } from '../ui.tsx';

export function Vat({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const s = useApi<{ inputVat: string; outputVat: string }>(`/api/companies/${books.company.id}/summary`);
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const c = books.company;
  const output = -toMinor(s.data.outputVat);
  const input = toMinor(s.data.inputVat);
  const net = output - input;
  return (
    <div className="card">
      <h2>{t('vat.title', { country: t(`country.${c.country}`), rate: Number(c.vatRate) })}</h2>
      <table>
        <tbody>
          <tr><td>{t('vat.output')}</td><td className="num ltr">{fmt(fromMinor(output))}</td></tr>
          <tr><td>{t('vat.input')}</td><td className="num ltr">{fmt(fromMinor(input))}</td></tr>
          <tr className="total"><td>{net >= 0n ? t('vat.net') : t('vat.refund')}</td><td className="num ltr">{fmt(fromMinor(net < 0n ? -net : net))} {c.currency}</td></tr>
        </tbody>
      </table>
      <p className="mut small">{t('vat.later', { einv: t(`einv.${c.country}`) })}</p>
    </div>
  );
}
