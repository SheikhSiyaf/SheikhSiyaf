// HRM routes: HR details, attendance, leave, loans, payroll, end of service, HR documents.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { uuidParam, today, type Ctx } from './context.js';
import * as H from '../books/hrmService.js';
import * as AT from '../books/attendanceService.js';

type P = { id: string };
async function member(db: Db, companyId: string) {
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}

export function registerHrmRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const companyOf = async (db: Db, table: 'payroll_runs' | 'leave_requests' | 'employee_documents' | 'payroll_lines', id: string) => {
    const r = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [uuidParam(id)])).rows[0];
    if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
    return r.company_id as string;
  };
  const ok = { ok: true };
  type Q = { Params: P; Querystring: Record<string, string | undefined> };

  app.get<Q>('/api/companies/:id/hr/overview', async (req) => inCompany(req, req.params.id, (db, c) => H.overview(db, c)));
  app.get<Q>('/api/companies/:id/hr/employees', async (req) => inCompany(req, req.params.id, (db, c) => H.employees(db, c)));
  app.get<Q>('/api/companies/:id/hr/settings', async (req) => inCompany(req, req.params.id, (db, c) => H.hrSettings(db, c)));
  app.post<{ Params: P; Body: Record<string, string> }>('/api/companies/:id/hr/settings', async (req) => inCompany(req, req.params.id, async (db, c) => { await H.saveHrSettings(db, c, req.body ?? {}); return ok; }));
  app.get<Q>('/api/employees/:id/hr', async (req) => as(req, (db) => H.employee(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: H.ProfileInput }>('/api/employees/:id/hr', async (req) => as(req, async (db) => { await H.saveProfile(db, uuidParam(req.params.id), req.body ?? {}); return ok; }));

  // attendance
  app.get<Q>('/api/companies/:id/hr/attendance', async (req) => inCompany(req, req.params.id, (db, c) => H.attendance(db, c, String(req.query.month ?? ''))));
  app.post<{ Params: P; Body: { month?: string; rows?: []; csv?: string } }>('/api/companies/:id/hr/attendance', async (req) => inCompany(req, req.params.id, (db, c) =>
    H.saveAttendance(db, c, String(req.body?.month ?? ''), req.body?.csv ? H.parseAttendanceCsv(req.body.csv) : req.body?.rows ?? [])));

  // time-clock files and corrections
  app.post<{ Params: P; Body: AT.ImportInput }>('/api/companies/:id/hr/attendance-import/preview', async (req) => inCompany(req, req.params.id, (db, c) => AT.importPreview(db, c, req.body ?? {})));
  app.post<{ Params: P; Body: AT.ImportInput }>('/api/companies/:id/hr/attendance-import/run', async (req) => inCompany(req, req.params.id, (db, c) => AT.importRun(db, c, req.body ?? {})));
  app.get<Q>('/api/companies/:id/hr/attendance-days', async (req) => inCompany(req, req.params.id, (db, c) => AT.monthDays(db, c, String(req.query.month ?? ''))));
  app.get<Q>('/api/companies/:id/hr/corrections', async (req) => inCompany(req, req.params.id, (db, c) => AT.listCorrections(db, c, req.query.status ?? '')));
  app.post<{ Params: P; Body: AT.CorrectionInput }>('/api/companies/:id/hr/corrections', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await AT.requestCorrection(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: { status?: string; note?: string } }>('/api/attendance-corrections/:id/status', async (req) =>
    as(req, async (db) => { await AT.decideCorrection(db, uuidParam(req.params.id), String(req.body?.status), req.body?.note); return ok; }));
  // leave
  app.get<Q>('/api/companies/:id/hr/leave', async (req) => inCompany(req, req.params.id, (db, c) => H.listLeave(db, c, req.query.status ?? '')));
  app.get<Q>('/api/companies/:id/hr/leave-balances', async (req) => inCompany(req, req.params.id, (db, c) => H.leaveBalances(db, c, req.query.asOf || today())));
  app.post<{ Params: P; Body: Parameters<typeof H.saveLeave>[2] }>('/api/companies/:id/hr/leave', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await H.saveLeave(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: { status?: string } }>('/api/leave/:id/status', async (req) => as(req, async (db) => { await H.decideLeave(db, uuidParam(req.params.id), String(req.body?.status)); return ok; }));

  // loans
  app.get<Q>('/api/companies/:id/hr/loans', async (req) => inCompany(req, req.params.id, (db, c) => H.listLoans(db, c)));
  app.post<{ Params: P; Body: Parameters<typeof H.issueLoan>[2] }>('/api/companies/:id/hr/loans', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await H.issueLoan(db, c, req.body ?? {}) })));

  // payroll
  app.get<Q>('/api/companies/:id/payroll', async (req) => inCompany(req, req.params.id, (db, c) => H.listRuns(db, c)));
  app.post<{ Params: P; Body: { month?: string } }>('/api/companies/:id/payroll', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await H.prepareRun(db, c, String(req.body?.month ?? '')) })));
  app.get<Q>('/api/payroll/:id', async (req) => as(req, (db) => H.getRun(db, uuidParam(req.params.id))));
  app.post<{ Params: P }>('/api/payroll/:id/refresh', async (req) => as(req, async (db) => {
    const r = await H.getRun(db, uuidParam(req.params.id));
    return { id: await H.prepareRun(db, r.companyId, r.periodEnd) };
  }));
  app.post<{ Params: P }>('/api/payroll/:id/post', async (req) => as(req, async (db) => ({ entryId: await H.postRun(db, uuidParam(req.params.id)) })));
  app.post<{ Params: P; Body: { bankAccountId?: string; date?: string } }>('/api/payroll/:id/pay', async (req) => as(req, async (db) => ({ entryId: await H.payRun(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.post<{ Params: P }>('/api/payroll/:id/delete', async (req) => as(req, async (db) => { await H.deleteDraft(db, uuidParam(req.params.id)); return ok; }));
  app.get<Q>('/api/payroll/:id/salary-file', async (req) => as(req, (db) => H.wpsFile(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: { bonus?: string; otherDeductions?: string; note?: string } }>('/api/payroll-lines/:id', async (req) => as(req, async (db) => { await H.updateLine(db, uuidParam(req.params.id), req.body ?? {}); return ok; }));

  // end of service
  app.get<Q>('/api/companies/:id/hr/end-of-service', async (req) => inCompany(req, req.params.id, async (db, c) => ({ ...(await H.eosSummary(db, c, req.query.asOf || today())), settlements: await H.listSettlements(db, c) })));
  app.post<{ Params: P; Body: { leavingDate?: string; reason?: string } }>('/api/employees/:id/settlement-preview', async (req) => as(req, (db) => H.settlementPreview(db, uuidParam(req.params.id), req.body ?? {})));
  app.post<{ Params: P; Body: { leavingDate?: string; reason?: string } }>('/api/employees/:id/settlement', async (req) => as(req, async (db) => ({ id: await H.settle(db, uuidParam(req.params.id), req.body ?? {}) })));

  // HR documents
  app.get<Q>('/api/companies/:id/hr/documents', async (req) => inCompany(req, req.params.id, (db, c) => H.listDocuments(db, c, req.query.employee ? uuidParam(req.query.employee) : undefined)));
  app.post<{ Params: P; Body: Parameters<typeof H.saveDocument>[2] }>('/api/companies/:id/hr/documents', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await H.saveDocument(db, c, req.body ?? {}) })));
  app.post<{ Params: P; Body: Parameters<typeof H.saveDocument>[2] }>('/api/hr-documents/:id', async (req) => as(req, async (db) =>
    ({ id: await H.saveDocument(db, await companyOf(db, 'employee_documents', req.params.id), req.body ?? {}, uuidParam(req.params.id)) })));
  app.post<{ Params: P }>('/api/hr-documents/:id/delete', async (req) => as(req, async (db) => { await H.deleteDocument(db, uuidParam(req.params.id)); return ok; }));
}
