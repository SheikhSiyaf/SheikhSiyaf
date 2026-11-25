import { ReviewedBadge } from '../review/Review.tsx';
import { useApi, type CompanyBooks } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Dashboard } from '../dash/Dashboard.tsx';

/** The home page: notices that need attention at the top, then the dashboard of widgets (web/src/dash). The setup checklist lives beside the bell. */
export function Home({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  return (
    <>
      <ReviewedBadge books={books} go={go} />
      <FromAccountant books={books} go={go} />
      <WaitingApproval books={books} go={go} />
      <Dashboard books={books} />
    </>
  );
}

/** What the accounting firm is waiting for, and its latest monthly report (client users of a firm's client). */
function FromAccountant({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const skip = books.portal?.firm || books.portal?.tenantKind === 'company';
  const o = useApi<{ openRequests: number; unreadLetters: number }>(skip ? null : `/api/companies/${books.company.id}/portal/overview`);
  if (skip || !o.data || (!o.data.openRequests && !o.data.unreadLetters)) return null;
  return (
    <div className="notice warn actions" id="home-portal">
      {o.data.openRequests > 0 && <span>{t('home.asked', { n: o.data.openRequests })}</span>}
      {o.data.unreadLetters > 0 && <span>{t('home.newReport')}</span>}
      <span className="spacer" />
      <button className="b small p" onClick={() => go('Portal', 'overview')}>{t('home.openPortal')}</button>
    </div>
  );
}

/** For approvers: bills, payments and credit notes waiting for their decision. */
function WaitingApproval({ books, go }: { books: CompanyBooks; go: (m: string, sub?: string) => void }) {
  const { t } = useI18n();
  const w = useApi<{ canApprove: boolean; toDecide: number; approvedToAction: number; corrections?: number }>(`/api/companies/${books.company.id}/approvals/waiting`);
  if (!w.data || (!w.data.toDecide && !w.data.corrections && !(books.canPost && w.data.approvedToAction))) return null;
  return (
    <div className="notice warn actions" id="home-approvals">
      {w.data.toDecide > 0 && <span>{t('home.toApprove', { n: w.data.toDecide })}</span>}
      {books.canPost && w.data.approvedToAction > 0 && <span>{t('home.approvedToAction', { n: w.data.approvedToAction })}</span>}
      {(w.data.corrections ?? 0) > 0 && <span>{t('appr.attCorrectionsHint', { n: w.data.corrections! })}</span>}
      <span className="spacer" />
      <button className="b small p" onClick={() => go('Approvals', 'waiting')}>{t('home.openApprovals')}</button>
    </div>
  );
}
