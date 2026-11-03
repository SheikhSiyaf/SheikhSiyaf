// Loads the demo firm (src/db/demoData.ts) so the app can be tried straight away.
// Runs as the owner but sets app.user_id for each step, so every rule and the audit log apply.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { postEntry, reverseEntry, type LineInput } from '../ledger/ledger.js';
import type { Db } from './session.js';
import { fromMinor } from '../money.js';
import { vatForLine } from '../vat/vat.js';
import { CHART_TEMPLATE } from '../books/chartTemplate.js';
import { approveClaim, createCredit, issueDocument, recordPayment, rejectClaim, saveContact, saveDraft, setQuotationStatus, submitClaim } from '../books/documentsService.js';
import { saveProject } from '../books/ledgerService.js';
import type { DocType } from '../books/documents.js';
import { saveRecurring } from '../books/expensesService.js';
import * as Bank from '../books/bankService.js';
import * as Inv from '../books/inventoryService.js';
import * as Fa from '../books/assetsService.js';
import * as Hr from '../books/hrmService.js';
import * as Crm from '../books/crmService.js';
import * as Review from '../books/reviewService.js';
import * as Cal from '../books/calendarService.js';
import * as Einv from '../books/einvoiceService.js';
import * as Portal from '../books/portalService.js';
import { addAttachment } from '../books/setupService.js';
import { tinyPdfBase64 } from './tinyPdf.js';
import * as Pay from '../books/payroll.js';
import { monthEnd, nextMonthEnd, previousMonthEnd, targetDepreciation } from '../books/assets.js';
import { toMinor } from '../money.js';
import { DEMO_COMPANIES, DEMO_FIRM, DEMO_PASSWORD, DEMO_RESTAURANT, DEMO_ROLES, DEMO_SELF, DEMO_SELF_ROLES, DEMO_USERS } from './demoData.js';
import { DEFAULT_MODULES } from '../books/modules.js';
import * as Rest from '../books/restaurantService.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const firstOfNextMonth = () => { const d = new Date(); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))); };

export async function seed(adminUrl: string): Promise<'seeded' | 'exists'> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const asUser = (id: string) => client.query("SELECT set_config('app.user_id', $1, true)", [id]);
  try {
    if ((await client.query('SELECT 1 FROM firms WHERE name = $1', [DEMO_FIRM])).rowCount) return 'exists';
    await client.query('BEGIN');
    const firmId: string = (await client.query('INSERT INTO firms (name) VALUES ($1) RETURNING id', [DEMO_FIRM])).rows[0].id;
    // The company that runs its own books is a customer of its own; the owner lives on the platform.
    const selfId: string = (await client.query(`INSERT INTO firms (name, kind) VALUES ($1, 'company') RETURNING id`, [DEMO_SELF])).rows[0].id;
    const platformId: string = (await client.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0].id;
    const tenantOf = (t?: string) => (t === 'self' ? selfId : t === 'platform' ? platformId : firmId);
    const hash = await hashPassword(DEMO_PASSWORD);

    const userIds: Record<string, string> = {};
    for (const u of DEMO_USERS) {
      userIds[u.email] = (await client.query(
        `INSERT INTO users (firm_id, kind, full_name, email, password_hash, staff_role, password_set_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [tenantOf(u.tenant), u.kind, u.name, u.email, hash, u.kind === 'firm_staff' ? u.role : null])).rows[0].id;
    }
    const admin = userIds['admin@firm.example']!;
    await asUser(admin);
    for (const r of DEMO_ROLES) {
      await client.query('INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve) VALUES ($1,$2,$3,$4,$5,$6)',
        [firmId, r.name, r.nameAr, r.description, JSON.stringify(r.permissions), r.canApprove]);
    }
    await asUser(userIds['admin@desertrose.example']!);
    const selfRoles: Record<string, string> = {};
    for (const r of DEMO_SELF_ROLES) {
      selfRoles[r.name] = (await client.query(`INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, can_review, can_sign_off)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [selfId, r.name, r.nameAr, r.description, JSON.stringify(r.permissions), r.canApprove, r.canReview, r.canSignOff])).rows[0].id;
    }
    await asUser(admin);

    const companyIds: Record<string, string> = {};
    for (const c of DEMO_COMPANIES) {
      const id: string = (await client.query(
        `INSERT INTO companies (firm_id, name, name_ar, country, currency, cr_number, legal_form, vat_status, vat_number,
           vat_rate, address, city, fy_end_month, fy_end_day, invoice_prefix, industry, modules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'registered',$8,$9,$10,$11,12,31,$12,$13,$14) RETURNING id`,
        [tenantOf(c.tenant), c.name, c.nameAr, c.country, c.currency, c.crNumber, c.legalForm, c.vatNumber, c.vatRate, c.address, c.city, c.invoicePrefix,
         c.industry, DEFAULT_MODULES[c.industry]])).rows[0].id;
      companyIds[c.key] = id;
      for (const u of DEMO_USERS.filter((x) => x.companies.includes(c.key))) {
        await client.query('INSERT INTO memberships (user_id, company_id, role, client_role_id) VALUES ($1,$2,$3,$4)', [userIds[u.email], id, u.role, u.clientRole ? selfRoles[u.clientRole] ?? null : null]);
      }
      await asUser(c.tenant === 'self' ? userIds['admin@desertrose.example']! : admin);
      await client.query('SELECT setup_company_books($1, $2, $3)', [id, JSON.stringify(CHART_TEMPLATE), new Date().getUTCFullYear()]);
      await client.query(`INSERT INTO cost_centres (company_id, kind, name, name_ar) VALUES ($1,'branch','Branch 1','الفرع 1'), ($1,'project','Project A','المشروع أ')`, [id]);
    }
    await client.query('COMMIT');

    // Postings, one transaction per company, as the people who would really post them.
    for (const c of DEMO_COMPANIES) {
      const id = companyIds[c.key]!;
      const poster = userIds[DEMO_USERS.find((u) => u.companies.includes(c.key) && ['client_accountant', 'staff_accountant'].includes(u.role))!.email]!;
      // Who approves and reviews: the firm's partner, or the company's own finance manager when it runs its own books.
      const partner = c.tenant === 'self' ? userIds['noura@desertrose.example']! : userIds['omar@firm.example']!;
      const acct = Object.fromEntries((await client.query('SELECT code, id FROM accounts WHERE company_id = $1', [id])).rows.map((r) => [r.code, r.id]));
      const cc = Object.fromEntries((await client.query('SELECT name, id FROM cost_centres WHERE company_id = $1', [id])).rows.map((r) => [r.name, r.id]));
      const gross = (net: number) => fromMinor(BigInt(net) * 100n + vatForLine(BigInt(net) * 100n, c.vatRate));
      const L = (code: string, debit?: string | number, credit?: string | number, centre?: string): LineInput => ({
        accountId: acct[code], debit: debit === undefined ? undefined : String(debit), credit: credit === undefined ? undefined : String(credit),
        costCentreId: centre ? cc[centre] : null });
      const post = (date: string, memo: string, lines: LineInput[]) => postEntry(client as unknown as Db, { companyId: id, entryDate: date, memo, lines });

      const db = client as unknown as Db;
      await client.query('BEGIN');
      await asUser(poster);
      await post(daysAgo(120), 'Opening balance', [L('1000', '50000.00'), L('3000', undefined, '50000.00')]);
      await post(daysAgo(60), 'Rent · head office', [L('5100', '4000.00', undefined, 'Head office'), L('1000', undefined, '4000.00')]);
      await post(daysAgo(25), 'Salaries', [L('5200', '6000.00', undefined, 'Head office'), L('5200', '2500.00', undefined, 'Branch 1'), L('1000', undefined, '8500.00')]);
      const wrong = await post(daysAgo(12), 'Office water delivery', [L('5400', '180.00'), L('1000', undefined, '180.00')]);
      await reverseEntry(db, wrong, daysAgo(11), 'Reversal: posted twice');

      // Customers and suppliers (fictional).
      const sa = c.country === 'SA';
      const vatNo = (n: number) => (sa ? `3${String(n).padStart(13, '0')}3` : String(100000000000000 + n));
      const cust = async (name: string, nameAr: string, vatN?: number, terms = 30) =>
        saveContact(db, id, { isCustomer: true, name, nameAr, country: c.country, vatNumber: vatN ? vatNo(vatN) : undefined, paymentTermsDays: terms, city: c.city,
          // Saudi business customers have their national address (needed on e-invoices).
          ...(sa && vatN ? { address: 'King Fahd Road', buildingNumber: String(1000 + (vatN % 9000)), district: 'Al Olaya', postalCode: '12211' } : {}) });
      const supp = async (name: string, nameAr: string, vatN?: number, terms = 15) =>
        saveContact(db, id, { isSupplier: true, name, nameAr, country: c.country, vatNumber: vatN ? vatNo(vatN) : undefined, paymentTermsDays: terms, city: c.city });
      const gulf = await cust('Gulf Steel Trading', 'الخليج للحديد', 1234567);
      const faisal = await cust('Al Faisal Contracting', 'الفيصل للمقاولات', 7654321, 30);
      const walkIn = await cust('Walk-in customer', 'عميل نقدي', undefined, 0);
      const najd = await supp('Najd Wholesale', 'نجد للجملة', 2223334);
      const telecom = await supp('Desert Telecom', 'الصحراء للاتصالات', 5556667);

      const SL = (description: string, quantity: string, unitPrice: string, centre?: string, code = '4000') =>
        ({ description, quantity, unitPrice, accountId: acct[code], costCentreId: centre ? cc[centre] : null, vatCode: 'standard' as const });
      const doc = async (type: DocType, contactId: string, issued: number, dueIn: number | null, lines: ReturnType<typeof SL>[], opts: { reference?: string; issue?: boolean } = {}) => {
        const did = await saveDraft(db, id, { type, contactId, issueDate: daysAgo(issued), dueDate: dueIn === null ? null : daysAgo(issued - dueIn), reference: opts.reference, lines });
        if (opts.issue !== false) await issueDocument(db, did);
        return did;
      };
      const pay = (direction: 'received' | 'made', contactId: string, ago: number, amount: string, accountCode: string, allocations: { documentId: string; amount: string }[], method = 'bank_transfer') =>
        recordPayment(db, id, { direction, contactId, date: daysAgo(ago), amount, accountId: acct[accountCode], method, allocations });

      const inv1 = await doc('invoice', gulf, 95, 30, [SL('Steel beams 12m', '20', '500.00', 'Head office')], { reference: 'PO-4471' });
      await pay('received', gulf, 80, gross(10000), '1000', [{ documentId: inv1, amount: gross(10000) }]);
      const inv2 = await doc('invoice', faisal, 34, 30, [SL('Rebar 16mm (tonnes)', '2', '2500.00', 'Head office'), SL('Delivery and offloading', '1', '2250.00', 'Branch 1')]);
      await pay('received', faisal, 12, '3000.00', '1000', [{ documentId: inv2, amount: '3000.00' }]);
      const cn = await createCredit(db, inv2);
      await saveDraft(db, id, { contactId: faisal, issueDate: daysAgo(10), reference: undefined, lines: [SL('Delivery and offloading (partial refund)', '1', '250.00', 'Branch 1')] }, cn);
      await issueDocument(db, cn);
      const inv3 = await doc('invoice', walkIn, 6, 0, [SL('Cut-to-size service', '3', '600.00', 'Project A')]);
      await pay('received', walkIn, 6, gross(1800), '1010', [{ documentId: inv3, amount: gross(1800) }], 'cash');
      await doc('invoice', gulf, 2, 30, [SL('Steel plates 6mm', '15', '300.00', 'Head office')], { reference: 'PO-4520' });
      await doc('invoice', gulf, 0, 30, [SL('Angle iron 50x50', '40', '45.00', 'Head office')], { issue: false });
      const q = await doc('quotation', faisal, 10, 30, [SL('Structural steel package', '1', '12000.00', 'Head office')], { issue: false });
      await setQuotationStatus(db, q, 'sent');

      const bill1 = await doc('bill', najd, 30, 15, [SL('Steel stock purchase', '1', '3200.00', undefined, '5000')], { reference: 'NW-88102' });
      await pay('made', najd, 20, gross(3200), '1000', [{ documentId: bill1, amount: gross(3200) }]);
      await doc('bill', telecom, 10, 15, [SL('Internet and phone lines', '1', '420.00', undefined, '5300')], { reference: 'DT-5531' });
      await post(daysAgo(1), 'Electricity', [L('5300', '650.00'), L('1000', undefined, '650.00')]);

      // Expenses paid straight away, and recurring templates (one is due, so its draft can be created).
      for (const [ago, payee, code, bankCode, desc, amount, vatCode, centre] of [
        [18, 'Petrol station', '5400', '1010', 'Fuel for delivery van', '150.00', 'standard', undefined],
        [9, 'Al Waha Office Supplies', '5400', '1000', 'Printer toner and paper', '420.00', 'standard', undefined],
        [4, 'City taxi', '5400', '1010', 'Taxi to customer site', '45.00', 'zero', undefined],
      ] as const) {
        const did = await saveDraft(db, id, { type: 'expense', payee, paidFromAccountId: acct[bankCode], issueDate: daysAgo(ago),
          lines: [{ ...SL(desc, '1', amount, centre, code), vatCode }] });
        await issueDocument(db, did);
      }
      await saveRecurring(db, id, { name: 'Office rent', payee: 'Al Olaya Properties', paidFromAccountId: acct['1000'], frequency: 'monthly',
        nextDate: firstOfNextMonth(), lines: [{ ...SL('Monthly office rent', '1', '4000.00', 'Head office', '5100'), vatCode: 'exempt' }] });
      await saveRecurring(db, id, { name: 'Internet and phones', contactId: telecom, paidFromAccountId: acct['1000'], frequency: 'monthly',
        nextDate: daysAgo(2), lines: [{ ...SL('Fibre internet and 5 mobile lines', '1', '299.00', undefined, '5300'), vatCode: 'standard' }] });

      // Projects: Project A gets a customer and budget; a second project with its own invoice and costs.
      await client.query(`UPDATE cost_centres SET budget = 5000, contact_id = $2, start_date = $3 WHERE company_id = $1 AND name = 'Project A'`, [id, walkIn, daysAgo(40)]);
      const fitOut = await saveProject(db, id, { name: 'Warehouse fit-out', nameAr: 'تجهيز المستودع', contactId: faisal, budget: '8000.00', startDate: daysAgo(30) });
      const pInv = await saveDraft(db, id, { type: 'invoice', contactId: faisal, issueDate: daysAgo(15), dueDate: daysAgo(-15),
        lines: [{ ...SL('Fit-out works, stage 1', '1', '9500.00', undefined), costCentreId: fitOut }] });
      await issueDocument(db, pInv);
      const pBill = await saveDraft(db, id, { type: 'bill', contactId: najd, issueDate: daysAgo(14), dueDate: daysAgo(-1), reference: 'NW-88190',
        lines: [{ ...SL('Shelving and racks', '1', '5200.00', undefined, '5000'), costCentreId: fitOut }] });
      await issueDocument(db, pBill);

      // Employees and their expense claims: one reimbursed, one waiting for approval, one rejected.
      const yusuf = await saveContact(db, id, { isEmployee: true, name: 'Yusuf Karim', nameAr: 'يوسف كريم', employeeNo: 'E-001', jobTitle: 'Driver', defaultCostCentreId: cc['Branch 1'] });
      const mona = await saveContact(db, id, { isEmployee: true, name: 'Mona Saeed', nameAr: 'منى سعيد', employeeNo: 'E-002', jobTitle: 'Site engineer', defaultCostCentreId: fitOut });
      const claim = (who: string, ago: number, desc: string, amount: string, code: string, centre: string | null, vatCode: 'standard' | 'zero' = 'standard') =>
        saveDraft(db, id, { type: 'claim', contactId: who, issueDate: daysAgo(ago), reference: `R-${ago}`, lines: [{ ...SL(desc, '1', amount, undefined, code), costCentreId: centre, vatCode }] });
      const c1 = await claim(yusuf, 20, 'Fuel and tolls for deliveries', '230.00', '5400', cc['Branch 1']);
      await submitClaim(db, c1);
      const c2 = await claim(mona, 8, 'Site materials bought on the spot', '640.00', '5000', fitOut);
      await submitClaim(db, c2);
      const c3 = await claim(yusuf, 5, 'Lunch with customer', '180.00', '5400', null, 'zero');
      await submitClaim(db, c3);
      await asUser(partner);   // someone other than the person who submitted decides
      await approveClaim(db, c1);
      await rejectClaim(db, c3, 'Customer lunches need a pre-approval form');
      await asUser(poster);
      const owed = (await client.query('SELECT document_amount_due($1)::text AS d', [c1])).rows[0].d;
      await recordPayment(db, id, { direction: 'made', contactId: yusuf, date: daysAgo(16), amount: owed, accountId: acct['1010'], method: 'cash',
        allocations: [{ documentId: c1, amount: owed }] });
      void c2;

      // Fixed assets the client already owned when the books started, with their depreciation so far.
      const fa = [
        { name: 'Delivery van', nameAr: 'شاحنة التوصيل', code: '1510', bought: daysAgo(430), cost: 85000n, residual: 15000n, life: 60, centre: 'Branch 1', serial: 'ABC 1234' },
        { name: 'Office furniture', nameAr: 'أثاث المكتب', code: '1520', bought: daysAgo(800), cost: 18000n, residual: 0n, life: 84, centre: 'Head office', serial: null },
        { name: 'Laptops (4)', nameAr: 'أجهزة حاسب محمولة (4)', code: '1530', bought: daysAgo(300), cost: 9600n, residual: 0n, life: 36, centre: 'Head office', serial: null },
      ];
      const booksStart = daysAgo(120);
      const opening = fa.map((x) => targetDepreciation({ cost: x.cost * 100n, residual: x.residual * 100n, lifeMonths: x.life, start: `${x.bought.slice(0, 7)}-01`, opening: 0n },
        previousMonthEnd(booksStart)));
      const totalCost = fa.reduce((t, x) => t + x.cost * 100n, 0n), totalOpening = opening.reduce((t, x) => t + x, 0n);
      await post(booksStart, 'Opening balances · fixed assets', [...fa.map((x) => L(x.code, fromMinor(x.cost * 100n))), L('1590', undefined, fromMinor(totalOpening)),
        L('3000', undefined, fromMinor(totalCost - totalOpening))]);
      for (const [i, x] of fa.entries()) {
        await Fa.saveAsset(db, id, { name: x.name, nameAr: x.nameAr, assetAccountId: acct[x.code], purchaseDate: x.bought, cost: fromMinor(x.cost * 100n),
          residualValue: fromMinor(x.residual * 100n), usefulLifeMonths: x.life, openingDepreciation: fromMinor(opening[i]!), costCentreId: cc[x.centre], serialNo: x.serial ?? undefined });
      }
      for (let m = monthEnd(booksStart); m <= previousMonthEnd(daysAgo(0)); m = nextMonthEnd(m)) await Fa.runDepreciation(db, id, m);

      // HRM: HR details for both employees, opening end of service provision, leave, attendance, a loan,
      // documents (one expiring soon), and payroll for the last two months (the earlier one paid).
      const people = [
        { id: yusuf, nationality: sa ? 'EG' : 'IN', joined: daysAgo(900), basic: '3000.00', housing: '750.00', transport: '300.00', iban: sa ? 'SA4420000001234567891234' : 'AE460260001015333439101', wps: '10000123456781' },
        { id: mona, nationality: c.country, joined: daysAgo(2400), basic: '9000.00', housing: '2250.00', transport: '600.00', iban: sa ? 'SA0380000000608010167519' : 'AE070331234567890123456', wps: '10000123456782' },
      ];
      let openingEos = 0n;
      for (const pp of people) {
        const eos = Pay.endOfService({ country: c.country as Pay.Country, joinDate: pp.joined, endDate: previousMonthEnd(booksStart),
          pay: { basic: toMinor(pp.basic), housing: toMinor(pp.housing), transport: toMinor(pp.transport), other: 0n }, reason: 'termination' }, true).amount;
        openingEos += eos;
        await Hr.saveProfile(db, pp.id, { nationality: pp.nationality, joinDate: pp.joined, basic: pp.basic, housing: pp.housing, transport: pp.transport, iban: pp.iban,
          idNumber: sa ? (pp.nationality === 'SA' ? '1087654321' : '2398765432') : '784199012345678', passportNo: pp.nationality === c.country ? null : 'A1234567',
          insuranceRegistered: pp.nationality === 'SA' ? daysAgo(2400) : null, bankRouting: sa ? null : '600310101', wpsPersonId: sa ? null : pp.wps,
          openingEos: fromMinor(eos), openingLeaveDays: pp.id === mona ? '12.50' : '4.00', openingAsOf: previousMonthEnd(booksStart) });
      }
      await post(booksStart, 'Opening balances · end of service provision', [L('3000', fromMinor(openingEos)), L('2230', undefined, fromMinor(openingEos))]);
      if (!sa) await Hr.saveHrSettings(db, id, { employerId: '0000001234567', bankRouting: '600310101', insuranceNo: 'GP-55120' });
      else await Hr.saveHrSettings(db, id, { employerId: '7001234567', insuranceNo: '500123456' });
      const payMonths = [previousMonthEnd(previousMonthEnd(daysAgo(0))), previousMonthEnd(daysAgo(0))];
      await Hr.saveLeave(db, id, { contactId: mona, kind: 'annual', startDate: `${payMonths[1]!.slice(0, 8)}10`, endDate: `${payMonths[1]!.slice(0, 8)}14`, reason: 'Family visit', approve: true });
      await Hr.saveLeave(db, id, { contactId: yusuf, kind: 'sick', startDate: `${payMonths[0]!.slice(0, 8)}06`, endDate: `${payMonths[0]!.slice(0, 8)}07`, approve: true });
      await Hr.saveLeave(db, id, { contactId: yusuf, kind: 'annual', startDate: daysAgo(-10), endDate: daysAgo(-17), reason: 'Eid holiday travel' });
      await Hr.issueLoan(db, id, { contactId: yusuf, date: `${payMonths[0]!.slice(0, 8)}03`, amount: '2000.00', installment: '500.00', bankAccountId: acct['1000'], notes: 'Salary advance' });
      await Hr.saveAttendance(db, id, payMonths[1]!, [{ contactId: yusuf, absentDays: 1, overtimeHours: '12' }, { contactId: mona, absentDays: 0, overtimeHours: '0' }]);
      for (const [n, m] of payMonths.entries()) {
        const run = await Hr.prepareRun(db, id, m);
        await Hr.postRun(db, run);
        if (n === 0) await Hr.payRun(db, run, { bankAccountId: acct['1000'], date: daysAgo(Math.max(1, Math.round((Date.now() - Date.parse(m)) / 86400000) - 1)) });
      }
      const docs: [string, string, string, string][] = [
        [yusuf, sa ? 'iqama' : 'emirates_id', sa ? '2398765432' : '784-1990-1234567-1', daysAgo(-25)],
        [yusuf, 'passport', 'A1234567', daysAgo(-900)],
        [yusuf, 'medical_insurance', 'MED-44821', daysAgo(-50)],
        [mona, sa ? 'national_id' : 'emirates_id', sa ? '1087654321' : '784-1985-7654321-2', daysAgo(-1400)],
        [mona, 'contract', 'C-2019-07', ''],
      ];
      for (const [who, kind, number, expiry] of docs) await Hr.saveDocument(db, id, { contactId: who, kind, number, expiryDate: expiry || undefined });

      // CRM: a campaign and its leads, a lead made a customer with a deal and quotation, deals at each stage, follow-ups.
      const crmCampaign = await Crm.saveCampaign(db, id, { name: sa ? 'Ramadan offer' : 'Dubai expo stand', channel: sa ? 'whatsapp' : 'event', startDate: daysAgo(40), endDate: daysAgo(10),
        budget: '3000.00', status: 'done', audience: sa ? 'Contractors in Riyadh' : 'Hotels and restaurants' });
      await Crm.saveCampaign(db, id, { name: 'Year-end newsletter', channel: 'email', startDate: daysAgo(-20), budget: '500.00', status: 'planned' });
      const lead1 = await Crm.saveLead(db, id, { name: 'Najran Builders', nameAr: 'بناة نجران', contactPerson: 'Saeed', phone: '+966 55 123 4567', campaignId: crmCampaign, estimatedValue: '18000.00', ownerId: poster, status: 'qualified' });
      await Crm.saveLead(db, id, { name: 'Coastal Hotels', contactPerson: 'Reem', email: 'purchasing@coastal.example', campaignId: crmCampaign, estimatedValue: '9000.00', ownerId: poster, status: 'contacted' });
      await Crm.saveLead(db, id, { name: 'Prime Clinics', phone: '+966 50 765 4321', source: 'referral', estimatedValue: '6000.00', status: 'new' });
      await Crm.saveLead(db, id, { name: 'Desert Cafe', phone: '+966 54 000 1122', source: 'walk_in', status: 'lost', lostReason: 'Chose a cheaper supplier', campaignId: crmCampaign });
      const conv = await Crm.convertLead(db, lead1, { dealTitle: 'Steel frames for villa project', dealValue: '18000.00' });
      const q1 = await Crm.quoteDeal(db, conv.dealId!);
      await setQuotationStatus(db, q1, 'sent');
      const d2 = await Crm.saveDeal(db, id, { title: 'Annual supply contract', contactId: gulf, value: '42000.00', stage: 'negotiation', expectedClose: daysAgo(-14), ownerId: poster });
      await Crm.saveDeal(db, id, { title: 'Warehouse racks phase 2', contactId: faisal, value: '12500.00', stage: 'qualified', expectedClose: daysAgo(-30) });
      await Crm.saveDeal(db, id, { title: 'Spare parts order', contactId: gulf, value: '3200.00', stage: 'new' });
      await Crm.saveDeal(db, id, { title: 'Delivery and installation', contactId: faisal, value: '7800.00', stage: 'won' });
      await Crm.saveDeal(db, id, { title: 'Site cleaning', contactId: walkIn, value: '1500.00', stage: 'lost', lostReason: 'Customer postponed' });
      await Crm.saveActivity(db, id, { kind: 'call', subject: 'Call about the quotation', dueDate: daysAgo(2), dealId: conv.dealId, ownerId: poster });
      await Crm.saveActivity(db, id, { kind: 'meeting', subject: 'Contract terms meeting', dueDate: daysAgo(0), dueTime: '11:00', dealId: d2, ownerId: poster });
      await Crm.saveActivity(db, id, { kind: 'email', subject: 'Send product catalogue', dueDate: daysAgo(-3), contactId: gulf });
      await Crm.saveActivity(db, id, { kind: 'task', subject: 'Prepare samples', dueDate: daysAgo(-7), ownerId: poster });
      const doneAct = await Crm.saveActivity(db, id, { kind: 'call', subject: 'First call with Najran Builders', dueDate: daysAgo(12), leadId: lead1 });
      await Crm.setActivityDone(db, doneAct, true);

      if (c.industry === 'restaurant') {
        // Restaurant: kitchen materials in stock, the menu with recipes, and the last few days' food sales.
        const mats: Record<string, string> = {};
        for (const m of DEMO_RESTAURANT.materials) mats[m.sku] = await Inv.saveItem(db, id, { sku: m.sku, name: m.name, nameAr: m.nameAr, unit: m.unit, reorderLevel: m.reorder });
        const grn = await Inv.saveNoteDraft(db, id, { type: 'grn', date: daysAgo(20), contactId: najd, reference: 'Weekly delivery',
          lines: DEMO_RESTAURANT.materials.map((m) => ({ itemId: mats[m.sku]!, quantity: m.qty, unitCost: m.cost })) });
        await Inv.postNote(db, grn);
        const menu: Record<string, string> = {};
        for (const r of DEMO_RESTAURANT.recipes) {
          menu[r.name] = await Rest.saveRecipe(db, id, { name: r.name, nameAr: r.nameAr, category: r.category, salePrice: r.price,
            lines: r.lines.map(([sku, quantity]) => ({ itemId: mats[sku]!, quantity })) });
        }
        for (const sale of DEMO_RESTAURANT.sales) {
          await Rest.sellFood(db, id, { date: daysAgo(sale.ago), method: sale.method, accountId: sale.method === 'cash' ? acct['1010'] : sale.method === 'card' ? acct['1000'] : null,
            contactId: sale.method === 'on_account' ? faisal : null, costCentreId: cc['Head office'], lines: sale.items.map(([name, quantity]) => ({ recipeId: menu[name]!, quantity })) });
        }
      } else {
        // Inventory: opening stock, a delivery from a supplier (its bill comes later, so 2050 shows it), and goods delivered to a customer.
        const item = (sku: string, name: string, nameAr: string, unit: string, salePrice: string, reorderLevel: string) =>
          Inv.saveItem(db, id, { sku, name, nameAr, unit, salePrice, reorderLevel });
        const beam = await item('ST-12', 'Steel beam 12m', 'عارضة حديد 12م', 'pcs', '650.00', '10');
        const rebar = await item('RB-16', 'Rebar 16mm', 'حديد تسليح 16مم', 'ton', '2600.00', '3');
        const angle = await item('AI-50', 'Angle iron 50x50', 'زاوية حديد 50×50', 'pcs', '45.00', '50');
        const note = async (type: 'grn' | 'gdn', ago: number, contactId: string | null, lines: Inv.NoteLineInput[], reference?: string, otherCode?: string) => {
          const nid = await Inv.saveNoteDraft(db, id, { type, date: daysAgo(ago), contactId, reference, otherAccountId: otherCode ? acct[otherCode] : null, lines });
          await Inv.postNote(db, nid);
        };
        await note('grn', 110, null, [{ itemId: beam, quantity: '30', unitCost: '410.00' }, { itemId: rebar, quantity: '6', unitCost: '2150.00' }, { itemId: angle, quantity: '200', unitCost: '28.50' }],
          'Opening stock count', '3000');
        await note('grn', 9, najd, [{ itemId: beam, quantity: '20', unitCost: '425.00' }, { itemId: angle, quantity: '100', unitCost: '29.00' }], 'NW-DN-5531');
        await note('gdn', 3, gulf, [{ itemId: beam, quantity: '15', costCentreId: cc['Head office'] }, { itemId: angle, quantity: '40', costCentreId: cc['Head office'] }], 'PO-4520');
        await note('gdn', 1, faisal, [{ itemId: rebar, quantity: '4', costCentreId: fitOut }], 'Warehouse fit-out');
      }

      // Bank: the client's bank account details, last month's statement imported, and two rules.
      const bankId = (await client.query('SELECT id FROM bank_accounts WHERE account_id = $1', [acct['1000']])).rows[0].id;
      await Bank.saveBankAccount(db, id, sa ? { kind: 'bank', iban: 'SA03 8000 0000 6080 1016 7519', accountNumber: '608010167519', name: 'Al Rajhi Bank – current account', nameAr: 'مصرف الراجحي – الحساب الجاري' }
        : { kind: 'bank', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1234567890123456', name: 'Mashreq – current account', nameAr: 'بنك المشرق – الحساب الجاري' }, bankId);
      const from = daysAgo(45);
      const inBooks = (await client.query(
        `SELECT e.entry_date::text AS date, e.memo, (l.debit - l.credit)::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = $1 AND e.entry_date >= $2 AND e.entry_date < $3 ORDER BY e.entry_date, e.created_at`, [acct['1000'], from, daysAgo(1)])).rows
        .filter((r) => !/Office water|Reversal/.test(r.memo ?? ''))
        .map((r) => ({ date: r.date as string, description: String(r.memo ?? 'TRANSFER').replace(/^[A-Z]+-\d+ · /, (m: string) => (toMinor(r.amount) > 0n ? 'TRF IN ' : 'TRF OUT ') + m).toUpperCase(), amount: r.amount as string }));
      const extras = [
        { date: daysAgo(30), description: 'STC BUSINESS BILL 0112233', amount: sa ? '-345.00' : '-157.50' },
        { date: daysAgo(14), description: 'POS PETROMIN STATION 44', amount: '-86.25' },
        { date: daysAgo(7), description: 'BANK SERVICE CHARGES', amount: '-25.00' },
        { date: daysAgo(5), description: 'STC BUSINESS BILL 0112233', amount: sa ? '-299.00' : '-136.50' },
      ];
      const all = [...inBooks, ...extras].sort((a, b) => a.date.localeCompare(b.date));
      let bal = toMinor((await client.query(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`,
        [acct['1000'], from])).rows[0].v);
      const statement = all.map((l) => { bal += toMinor(l.amount); return { ...l, reference: null, balance: fromMinor(bal) }; });
      await Bank.importStatement(db, bankId, { fileName: 'statement-last-45-days.csv', lines: statement });
      await Bank.saveRule(db, id, { matchText: 'STC', direction: 'out', accountId: acct['5300'], vatCode: 'standard', label: 'Mobile and internet' });
      await Bank.saveRule(db, id, { matchText: 'BANK SERVICE CHARGES', direction: 'out', accountId: acct['5400'], vatCode: 'exempt', label: 'Bank charges' });
      for (const l of await Bank.statementLines(db, bankId, { status: 'open' })) {
        if (l.suggestion?.kind === 'match' && l.date < daysAgo(20)) await Bank.matchLine(db, l.id, l.suggestion.journalLineId);
      }

      // Review: the month before last is reviewed and signed off by the partner; last month has queries going.
      await asUser(partner);
      const before = previousMonthEnd(previousMonthEnd(daysAgo(0))), last = previousMonthEnd(daysAgo(0));
      const q0 = await Review.raiseQuery(db, id, { periodEnd: before, subject: 'Office water delivery posted twice', body: 'We see a reversal for the water delivery. Was it paid once only?' });
      await asUser(poster);
      await Review.reply(db, q0, 'Yes, paid once. The second entry was a mistake and is reversed.');
      await asUser(partner);
      await Review.setQueryStatus(db, q0, 'closed');
      for (const item of (await Review.checklist(db, id, before)).items.filter((i) => !i.done)) {
        await Review.tick(db, id, before, item.item, true, item.auto === false ? 'Checked: open items are next month\'s' : null);
      }
      await Review.signOff(db, id, before, 'Reviewed. VAT return can be filed.');
      const checks = await Review.runChecks(db, id, last);
      const round = checks.find((c) => c.key === 'round_amounts')?.findings[0];
      if (round) await Review.explain(db, id, { check: 'round_amounts', item: round.itemKey, note: 'Agreed with the client' });
      await Review.raiseQuery(db, id, { periodEnd: last, subject: 'Supplier bill without tax invoice', body: 'Please attach the supplier\'s tax invoice for the last bill from Najd Wholesale.', aboutType: 'check', aboutId: 'missing_input_vat' });
      const q2 = await Review.raiseQuery(db, id, { periodEnd: last, subject: 'Cash on hand', body: 'Can you confirm the cash count at the month end?' });
      await asUser(poster);
      await Review.reply(db, q2, 'Counted on the last day; it agrees with the books.');
      await asUser(partner);
      await Review.tick(db, id, last, 'sales_complete', true);
      await Review.tick(db, id, last, 'purchases_complete', true);

      // E-invoicing: Saudi clients have their national address saved, ready to connect to ZATCA (Sales > E-invoicing).
      if (c.country === 'SA') await Einv.saveSettings(db, id, { street: c.address, buildingNumber: '2322', district: 'Al Murabba', postalCode: '23333' });

      // Calendar: earlier deadlines filed (the latest left to do), and the client's own licence renewal.
      await asUser(poster);
      const overdue = (await Cal.calendar(db, id, daysAgo(0))).filter((i) => i.status === 'overdue');
      for (const [n, i] of overdue.slice(0, -1).entries()) await Cal.markDone(db, id, i.key, { reference: `${i.kind === 'vat_return' ? 'VAT' : 'REF'}-${2600 + n}` });
      await Cal.saveCustom(db, id, { title: c.country === 'AE' ? 'Municipality permit renewal' : 'Baladiya licence renewal', titleAr: 'تجديد رخصة البلدية', firstDue: daysAgo(-20), repeat: 'yearly' });
      await Cal.saveCustom(db, id, { title: 'Civil defence certificate', titleAr: 'شهادة الدفاع المدني', firstDue: daysAgo(-75), repeat: 'yearly' });

      // Portal (clients of the accounting firm): requests, documents both ways, and last signed-off month's report.
      const client1 = DEMO_USERS.find((u) => u.kind === 'client' && u.companies.includes(c.key));
      if (c.tenant !== 'self' && client1) {
        const clientId = userIds[client1.email]!;
        await asUser(partner);
        await Portal.createRequest(db, id, { title: `Bank statement for ${monthName(last)}`, category: 'bank_statement', periodEnd: last, dueDate: daysAgo(-5), details: 'All pages, as a PDF from online banking.' });
        const lease = await Portal.createRequest(db, id, { title: 'Signed office lease', category: 'contract', details: 'We need it to spread the rent over the lease period.' });
        const shared = await Portal.createUpload(db, id, { category: 'tax', periodEnd: before, note: 'VAT return as filed, for your records.' });
        await addAttachment(db, { portalUploadId: shared }, { fileName: 'vat-return-filed.pdf', contentType: 'application/pdf', data: tinyPdfBase64([`VAT return - ${c.name}`, `Period ending ${before}`, 'Filed through the authority portal.']) });
        await Portal.publishLetter(db, id, { periodEnd: before, commentary: `Hello,\n\nWe have finished ${monthName(before)}. Sales and costs are in line with the month before, and the VAT return is filed.\n\nPlease send the bank statement and the signed lease we asked for, so we can close ${monthName(last)} on time.\n\nKind regards,\nOmar` });
        await asUser(clientId);
        const sent = await Portal.createUpload(db, id, { requestId: lease, category: 'contract', note: 'Signed by both parties. Two years from January.' });
        await addAttachment(db, { portalUploadId: sent }, { fileName: 'office-lease-signed.pdf', contentType: 'application/pdf', data: tinyPdfBase64(['Office lease agreement', c.name, 'Term: 24 months', 'Signed by landlord and tenant']) });
        const receipts = await Portal.createUpload(db, id, { category: 'receipts', periodEnd: last, note: 'Fuel and parking receipts.' });
        await addAttachment(db, { portalUploadId: receipts }, { fileName: 'receipts.pdf', contentType: 'application/pdf', data: tinyPdfBase64(['Receipts', 'Fuel 180.00', 'Parking 45.00']) });
      }
      await asUser(poster);
      await client.query('COMMIT');

      // The partner locks every month that ended more than a month ago.
      await client.query('BEGIN');
      await asUser(partner);
      await client.query(
        `UPDATE periods SET locked_at = now() WHERE company_id = $1 AND locked_at IS NULL
           AND end_date < date_trunc('month', current_date) - interval '1 month'`, [id]);
      await client.query('COMMIT');
    }
    return 'seeded';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed(config.databaseAdminUrl)
    .then((r) => console.log(r === 'seeded'
      ? `Demo data loaded. Sign in with any demo user, password "${DEMO_PASSWORD}".`
      : 'Demo data is already loaded.'))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
