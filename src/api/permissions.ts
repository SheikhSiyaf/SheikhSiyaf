// Access by client role. A client user given a role (Administrator > Roles and permissions) may only use the
// modules the role allows: "view" to read, "edit" to change. Each request below is matched to its module(s) and
// checked before it runs. Separation between companies stays in the database (row-level security); this decides
// which modules a person may use inside a company they belong to.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import type { Ctx } from './context.js';
import { accessTo, type AccessLevel } from '../books/modules.js';

type Need = { companyId: string; modules: string[]; approve?: boolean; also?: string[] } | null;
type Rule = [method: 'GET' | 'POST' | '*', path: RegExp, resolve: (db: Db, m: RegExpMatchArray, req: FastifyRequest) => Promise<Need> | Need];

const UUID = '([0-9a-f-]{36})';
const docModules = (type: string) => (type === 'expense' || type === 'claim' ? ['Expenses']
  : ['bill', 'supplier_credit'].includes(type) ? ['Purchases'] : ['Sales']);
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>;

async function docOwner(db: Db, id: string): Promise<Need> {
  const r = (await db.query('SELECT company_id, type FROM documents WHERE id = $1', [id])).rows[0];
  return r ? { companyId: r.company_id, modules: docModules(r.type) } : null;
}
async function companyOf(db: Db, table: string, id: string, modules: string[]): Promise<Need> {
  const r = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [id])).rows[0];
  return r ? { companyId: r.company_id, modules } : null;
}
const c = (modules: string[]) => (_db: Db, m: RegExpMatchArray): Need => ({ companyId: m[1]!, modules });

const RULES: Rule[] = [
  // documents and their attachments
  ['*', new RegExp(`^/api/companies/${UUID}/documents$`), (_db, m, req) => ({ companyId: m[1]!, modules: docModules(String(req.method === 'GET' ? query(req).type : body(req).type)) })],
  ['POST', new RegExp(`^/api/documents/${UUID}/(approve|reject)$`), async (db, m) => { const n = await docOwner(db, m[1]!); return n && { ...n, approve: true }; }],
  ['*', new RegExp(`^/api/documents/${UUID}(/.*)?$`), (db, m) => docOwner(db, m[1]!)],
  ['*', new RegExp(`^/api/attachments/${UUID}(/.*)?$`), async (db, m) => {
    const r = (await db.query(`SELECT a.company_id, d.type, a.stock_note_id, a.employee_document_id, a.portal_upload_id FROM attachments a LEFT JOIN documents d ON d.id = a.document_id WHERE a.id = $1`, [m[1]])).rows[0];
    if (r?.portal_upload_id) return null;   // portal files: open to everyone on the client (the database decides who sent them)
    return r ? { companyId: r.company_id, modules: r.employee_document_id ? ['HRM'] : r.stock_note_id ? ['Inventory', 'Restaurant'] : docModules(r.type) } : null;
  }],
  // customers, suppliers, employees (lists stay open to every member: they fill the pickers everywhere)
  ['POST', new RegExp(`^/api/companies/${UUID}/contacts$`), (_db, m, req) => {
    const b = body(req);
    return { companyId: m[1]!, modules: b.isEmployee ? ['HRM', 'Expenses'] : [...(b.isCustomer ? ['Sales', 'Restaurant'] : []), ...(b.isSupplier ? ['Purchases', 'Expenses'] : [])] };
  }],
  ['POST', new RegExp(`^/api/contacts/${UUID}$`), async (db, m) => {
    const r = (await db.query('SELECT company_id, is_customer, is_supplier, is_employee FROM contacts WHERE id = $1', [m[1]])).rows[0];
    return r ? { companyId: r.company_id, modules: r.is_employee ? ['HRM', 'Expenses'] : [...(r.is_customer ? ['Sales'] : []), ...(r.is_supplier ? ['Purchases'] : [])] } : null;
  }],
  // payments
  ['*', new RegExp(`^/api/companies/${UUID}/payments$`), (_db, m, req) => {
    const dir = req.method === 'GET' ? query(req).direction : body(req).direction;
    return { companyId: m[1]!, modules: dir === 'received' ? ['Sales'] : ['Purchases', 'Expenses'] };
  }],
  ['*', new RegExp(`^/api/payments/${UUID}(/.*)?$`), async (db, m) => {
    const r = (await db.query('SELECT company_id, direction FROM payments WHERE id = $1', [m[1]])).rows[0];
    return r ? { companyId: r.company_id, modules: r.direction === 'received' ? ['Sales'] : ['Purchases', 'Expenses'] } : null;
  }],
  ['GET', new RegExp(`^/api/companies/${UUID}/overview$`), (_db, m, req) => ({ companyId: m[1]!, modules: [query(req).side === 'purchases' ? 'Purchases' : 'Sales'] })],
  // expenses
  ['*', new RegExp(`^/api/companies/${UUID}/(recurring|expense-categories|expense-overview)(/.*)?$`), c(['Expenses'])],
  ['*', new RegExp(`^/api/recurring/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'recurring_expenses', m[1]!, ['Expenses'])],
  // journal, ledger, reports
  ['*', new RegExp(`^/api/companies/${UUID}/(entries|periods)(/.*)?$`), c(['Journal'])],
  ['POST', new RegExp(`^/api/entries/${UUID}/reverse$`), (db, m) => companyOf(db, 'journal_entries', m[1]!, ['Journal'])],
  ['GET', new RegExp(`^/api/companies/${UUID}/ledger/cost-centre/.*$`), c(['Ledger', 'Projects'])],
  ['*', new RegExp(`^/api/companies/${UUID}/(ledger|chart|accounts|cost-centres)(/.*)?$`), c(['Ledger'])],
  ['POST', new RegExp(`^/api/accounts/${UUID}$`), (db, m) => companyOf(db, 'accounts', m[1]!, ['Ledger'])],
  ['POST', new RegExp(`^/api/cost-centres/${UUID}$`), (db, m) => companyOf(db, 'cost_centres', m[1]!, ['Ledger'])],
  ['GET', new RegExp(`^/api/companies/${UUID}/reports/.*$`), c(['Reports'])],
  ['*', new RegExp(`^/api/companies/${UUID}/forecast(/.*)?$`), c(['Reports'])],
  ['*', new RegExp(`^/api/forecast/items/${UUID}$`), (db, m) => companyOf(db, 'forecast_items', m[1]!, ['Reports'])],
  ['POST', new RegExp(`^/api/companies/${UUID}/approvals/payments$`), c(['Purchases', 'Expenses'])],
  // bank
  ['GET', new RegExp(`^/api/companies/${UUID}/bank-accounts$`), c(['Bank', 'Restaurant'])],
  ['*', new RegExp(`^/api/companies/${UUID}/(bank-accounts|bank-rules)(/.*)?$`), c(['Bank'])],
  ['*', new RegExp(`^/api/bank-accounts/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'bank_accounts', m[1]!, ['Bank'])],
  ['*', new RegExp(`^/api/bank-lines/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'bank_statement_lines', m[1]!, ['Bank'])],
  ['*', new RegExp(`^/api/bank-imports/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'bank_imports', m[1]!, ['Bank'])],
  ['*', new RegExp(`^/api/bank-rules/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'bank_rules', m[1]!, ['Bank'])],
  // stock (inventory, or the restaurant's materials)
  ['*', new RegExp(`^/api/companies/${UUID}/(items|stock-notes|stock-value)(/.*)?$`), c(['Inventory', 'Restaurant'])],
  ['*', new RegExp(`^/api/items/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'items', m[1]!, ['Inventory', 'Restaurant'])],
  ['*', new RegExp(`^/api/stock-notes/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'stock_notes', m[1]!, ['Inventory', 'Restaurant'])],
  // restaurant
  ['*', new RegExp(`^/api/companies/${UUID}/(recipes|restaurant)(/.*)?$`), c(['Restaurant'])],
  ['*', new RegExp(`^/api/recipes/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'recipes', m[1]!, ['Restaurant'])],
  // HRM (salaries and personal details: HRM only)
  ['*', new RegExp(`^/api/companies/${UUID}/(hr|payroll)(/.*)?$`), c(['HRM'])],
  ['*', new RegExp(`^/api/employees/${UUID}/(hr|settlement|settlement-preview)$`), (db, m) => companyOf(db, 'contacts', m[1]!, ['HRM'])],
  ['POST', new RegExp(`^/api/leave/${UUID}/status$`), async (db, m, req) => {
    const n = await companyOf(db, 'leave_requests', m[1]!, ['HRM']);
    return n && { ...n, approve: body(req).status === 'approved' || body(req).status === 'rejected' };
  }],
  ['POST', new RegExp(`^/api/attendance-corrections/${UUID}/status$`), async (db, m, req) => {
    const n = await companyOf(db, 'hr_attendance_corrections', m[1]!, ['HRM']);
    return n && { ...n, approve: body(req).status === 'approved' || body(req).status === 'rejected' };
  }],
  ['GET', new RegExp(`^/api/companies/${UUID}/fx/(rate|rates)$`), c([])],   // rates are open to everyone in the company
  ['*', new RegExp(`^/api/companies/${UUID}/fx(/.*)?$`), c(['Ledger'])],
  ['*', new RegExp(`^/api/fx-revaluations/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'fx_revaluations', m[1]!, ['Ledger'])],
  ['*', new RegExp(`^/api/payroll/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'payroll_runs', m[1]!, ['HRM'])],
  ['*', new RegExp(`^/api/payroll-lines/${UUID}$`), (db, m) => companyOf(db, 'payroll_lines', m[1]!, ['HRM'])],
  ['*', new RegExp(`^/api/hr-documents/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'employee_documents', m[1]!, ['HRM'])],
  // CRM (a quotation made from a deal also needs Sales)
  ['POST', new RegExp(`^/api/crm/deals/${UUID}/quotation$`), async (db, m) => { const n = await companyOf(db, 'crm_deals', m[1]!, ['CRM']); return n && { ...n, modules: ['CRM'], also: ['Sales'] }; }],
  ['*', new RegExp(`^/api/companies/${UUID}/crm(/.*)?$`), c(['CRM'])],
  ['*', new RegExp(`^/api/crm/leads/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'crm_leads', m[1]!, ['CRM'])],
  ['*', new RegExp(`^/api/crm/deals/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'crm_deals', m[1]!, ['CRM'])],
  ['*', new RegExp(`^/api/crm/activities/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'crm_activities', m[1]!, ['CRM'])],
  ['*', new RegExp(`^/api/crm/campaigns/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'crm_campaigns', m[1]!, ['CRM'])],
  // bulk import: each kind to its module (view to preview, view and enter to import)
  ['POST', new RegExp(`^/api/companies/${UUID}/import/([a-z]+)/(preview|run)$`), (_db, m) => ({ companyId: m[1]!,
    modules: ({ customers: ['Sales'], suppliers: ['Purchases'], items: ['Inventory', 'Restaurant'], accounts: ['Ledger'], opening: ['Journal'] } as Record<string, string[]>)[m[2]!] ?? ['Ledger'] })],
  // e-invoicing belongs to Sales
  ['*', new RegExp(`^/api/companies/${UUID}/(einvoicing|einvoices)(/.*)?$`), c(['Sales', 'Restaurant'])],
  ['*', new RegExp(`^/api/einvoices/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'einvoices', m[1]!, ['Sales', 'Restaurant'])],
  ['*', new RegExp(`^/api/einvoicing/devices/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'einvoice_devices', m[1]!, ['Sales'])],
  // assets and projects
  ['*', new RegExp(`^/api/companies/${UUID}/(assets|asset-summary|depreciation)(/.*)?$`), c(['Assets'])],
  ['*', new RegExp(`^/api/assets/${UUID}(/.*)?$`), (db, m) => companyOf(db, 'fixed_assets', m[1]!, ['Assets'])],
  ['*', new RegExp(`^/api/companies/${UUID}/projects$`), c(['Projects'])],
  ['*', new RegExp(`^/api/projects/${UUID}$`), (db, m) => companyOf(db, 'cost_centres', m[1]!, ['Projects'])],
];

const rank: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

export function registerPermissionCheck(app: FastifyInstance, { as }: Ctx) {
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0]!;
    const rule = RULES.find(([method, re]) => (method === '*' || method === req.method) && re.test(path));
    if (!rule) return;
    if (!req.userId) return;   // signed out: the route answers "please sign in"
    await as(req, async (db) => {
      const need = await rule[2](db, path.match(rule[1])!, req);
      if (!need || !need.modules.length) return;
      const r = (await db.query('SELECT permissions, can_approve FROM app_client_role($1)', [need.companyId])).rows[0];
      if (!r) return;   // no client role: full access for the person's role (the database still applies it)
      const wanted = req.method === 'GET' ? 'view' : 'edit';
      const best = Math.max(...need.modules.map((m) => rank[accessTo(r.permissions, m)]));
      if (best < rank[wanted]) throw new HttpError(403, 'Your role does not allow this.', 'err.roleNoAccess');
      // Some actions touch a second module too (a deal's quotation is a Sales document): both are needed.
      if (need.also?.some((m) => rank[accessTo(r.permissions, m)] < rank[wanted])) throw new HttpError(403, 'Your role does not allow this.', 'err.roleNoAccess');
      if (need.approve && !r.can_approve) throw new HttpError(403, 'Your role does not allow approving claims.', 'err.roleNoApprove');
    }).catch((e) => {
      if (e instanceof HttpError && (e.key === 'err.roleNoAccess' || e.key === 'err.roleNoApprove')) throw e;
      // Signed-out requests and bad ids are answered by the route itself.
    });
  });
}
