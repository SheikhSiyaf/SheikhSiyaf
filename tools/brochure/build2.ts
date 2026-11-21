// The other six brochure companies. Same rules as build.ts: only the app's own services, only invented data.
import * as Inv from '../../src/books/inventoryService.js';
import * as Fa from '../../src/books/assetsService.js';
import * as Hr from '../../src/books/hrmService.js';
import * as Crm from '../../src/books/crmService.js';
import * as Rent from '../../src/books/rentalService.js';
import * as Room from '../../src/books/roomService.js';
import * as Rest from '../../src/books/restaurantService.js';
import { saveRecurringInvoice } from '../../src/books/toolsService.js';
import { saveContact, saveDraft, issueDocument, setQuotationStatus } from '../../src/books/documentsService.js';
import { saveProject } from '../../src/books/ledgerService.js';
import { monthEnd, nextMonthEnd, previousMonthEnd, targetDepreciation } from '../../src/books/assets.js';
import { fromMinor } from '../../src/money.js';
import { EXPAT, FAMILY, FIRST_F, FIRST_M, businessNames, daysAgo, fakeIban, type Ctx } from './lib.js';
import { bankStatement, fileDeadlines, note, opening, type Facts } from './common.js';

// ------------------------------------------------------------------ people and payroll
const SAUDI_NAMES = (r: () => number, n: number): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    const f = (r() < 0.25 ? FIRST_F : FIRST_M)[Math.floor(r() * 10)]!, fam = FAMILY[Math.floor(r() * FAMILY.length)]!;
    out.push([`${f[0]} ${fam[0]}`, `${f[1]} ${fam[1]}`]);
  }
  return out;
};

/** Employees with realistic pay, then payroll for the last two months (the earlier one paid). Returns the employee ids. */
export async function staff(c: Ctx, n: number, titles: [string, number, number][], centre?: string, months = 2): Promise<string[]> {
  const saudis = SAUDI_NAMES(c.r, Math.ceil(n * 0.3));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const saudi = i < saudis.length;
    const [title, lo, hi] = titles[i % titles.length]!;
    const name: [string, string] = saudi ? saudis[i]! : [EXPAT[(i * 3 + c.int(0, 2)) % EXPAT.length]!, ''];
    const id = await saveContact(c.db, c.id, { isEmployee: true, name: name[0], nameAr: name[1] || undefined, employeeNo: `E-${String(i + 1).padStart(3, '0')}`, jobTitle: title,
      defaultCostCentreId: centre ? c.cc[centre] : c.cc['Head office'] });
    const basic = Math.round(((lo + c.r() * (hi - lo)) * 0.6) / 50) * 50;
    await Hr.saveProfile(c.db, id, { nationality: saudi ? 'SA' : ['EG', 'IN', 'PK', 'PH', 'SD', 'BD'][i % 6], joinDate: daysAgo(c.int(200, 2400)), basic: basic.toFixed(2),
      housing: (basic * 0.25).toFixed(2), transport: (basic * 0.1).toFixed(2), iban: fakeIban(5000 + i * 13 + n), idNumber: `${saudi ? 1 : 2}${String(100000000 + i * 7919 + n).slice(0, 9)}`,
      passportNo: saudi ? null : `X${String(1000000 + i * 31)}`, insuranceRegistered: saudi ? daysAgo(c.int(300, 2000)) : null });
    ids.push(id);
  }
  await Hr.saveHrSettings(c.db, c.id, { employerId: '7001234567', insuranceNo: '500123456' });
  const last = previousMonthEnd(daysAgo(0)), before = previousMonthEnd(last);
  const runs = months === 1 ? [last] : [before, last];
  for (const [k, m] of runs.entries()) {
    const run = await Hr.prepareRun(c.db, c.id, m);
    await Hr.postRun(c.db, run);
    if (k === 0) await Hr.payRun(c.db, run, { bankAccountId: c.acct['1000'], date: daysAgo(Math.max(1, Math.round((Date.now() - Date.parse(m)) / 86400000) - 1)) });
  }
  return ids;
}

type AssetSpec = { name: string; nameAr: string; code: string; bought: number; cost: number; residual?: number; life: number; serial?: string };
/** Equipment already owned when the books started, with its depreciation to last month. */
export async function fixedAssets(c: Ctx, list: AssetSpec[], centre = 'Head office') {
  const booksStart = daysAgo(120);
  const opening_ = list.map((x) => targetDepreciation({ cost: BigInt(x.cost) * 100n, residual: BigInt(x.residual ?? 0) * 100n, lifeMonths: x.life, start: `${daysAgo(x.bought).slice(0, 7)}-01`, opening: 0n }, previousMonthEnd(booksStart)));
  const totalCost = list.reduce((t, x) => t + BigInt(x.cost) * 100n, 0n), totalOpening = opening_.reduce((t, x) => t + x, 0n);
  await c.post(booksStart, 'Opening balances · fixed assets', [...list.map((x) => c.L(x.code, fromMinor(BigInt(x.cost) * 100n))), c.L('1590', undefined, fromMinor(totalOpening)), c.L('3000', undefined, fromMinor(totalCost - totalOpening))]);
  for (const [i, x] of list.entries()) {
    await Fa.saveAsset(c.db, c.id, { name: x.name, nameAr: x.nameAr, assetAccountId: c.acct[x.code], purchaseDate: daysAgo(x.bought), cost: fromMinor(BigInt(x.cost) * 100n), residualValue: fromMinor(BigInt(x.residual ?? 0) * 100n),
      usefulLifeMonths: x.life, openingDepreciation: fromMinor(opening_[i]!), costCentreId: c.cc[centre], serialNo: x.serial });
  }
  for (let m = monthEnd(booksStart); m <= previousMonthEnd(daysAgo(0)); m = nextMonthEnd(m)) await Fa.runDepreciation(c.db, c.id, m);
}

/** Rent, utilities and suppliers' bills across three months, so the profit and loss looks like a real business. */
async function runningCosts(c: Ctx, rent: number, utilities: [number, number], supplierBills: { supplier: string; what: string; code: string; range: [number, number]; n: number; paid?: number }[], months: number[] = [85, 55, 25]) {
  for (const ago of months) {
    await c.post(daysAgo(ago), 'Rent', [c.L('5100', rent.toFixed(2), undefined, 'Head office'), c.L('1000', undefined, rent.toFixed(2))]);
    const u = c.money(...utilities);
    await c.post(daysAgo(ago - 3), 'Electricity and water', [c.L('5300', u), c.L('1000', undefined, u)]);
  }
  for (const b of supplierBills) {
    for (let k = 0; k < b.n; k++) {
      const ago = 80 - k * Math.floor(70 / b.n) - c.int(0, 3);
      const id = await c.doc('bill', b.supplier, ago, 21, [c.SL(b.what, '1', c.money(...b.range), 'Head office', b.code)], { reference: `INV-${c.int(1000, 9999)}` });
      if (k < (b.paid ?? b.n - 1)) await c.payFull('made', b.supplier, id, Math.max(1, ago - c.int(8, 18)));
    }
  }
}

// ------------------------------------------------------------------ restaurant
const MATERIALS: [string, string, string, number, number][] = [
  ['CHK', 'Chicken', 'دجاج', 24, 9], ['LMB', 'Lamb', 'لحم ضأن', 58, 4], ['BEF', 'Minced beef', 'لحم مفروم', 42, 6], ['RIC', 'Basmati rice', 'أرز بسمتي', 8.5, 25], ['FLR', 'Flour', 'طحين', 3.2, 30],
  ['TOM', 'Tomatoes', 'طماطم', 5.5, 12], ['ONI', 'Onions', 'بصل', 3.4, 15], ['CUC', 'Cucumber', 'خيار', 4.2, 8], ['LET', 'Lettuce', 'خس', 7.5, 5], ['CHS', 'Cheese', 'جبن', 36, 4],
  ['MLK', 'Fresh milk', 'حليب طازج', 6.2, 20], ['YOG', 'Yoghurt', 'لبن زبادي', 7.8, 10], ['EGG', 'Eggs (tray)', 'بيض (طبق)', 17, 6], ['OIL', 'Cooking oil', 'زيت طبخ', 9.5, 12], ['OLV', 'Olive oil', 'زيت زيتون', 41, 3],
  ['SPC', 'Spice mix', 'بهارات', 62, 2], ['DAT', 'Dates', 'تمر', 22, 8], ['COF', 'Coffee beans', 'حبوب القهوة', 88, 4], ['TEA', 'Tea', 'شاي', 34, 3], ['SGR', 'Sugar', 'سكر', 3.8, 15],
  ['BRD', 'Bread', 'خبز', 1.2, 60], ['HUM', 'Chickpeas', 'حمص', 6.1, 10], ['POT', 'Potatoes', 'بطاطس', 3.9, 15], ['FSH', 'Fish fillet', 'فيليه سمك', 47, 4], ['LMN', 'Lemons', 'ليمون', 6.5, 5], ['CRM', 'Cream', 'قشطة', 19, 4],
];
// name, Arabic, category, price, [material code, quantity per portion] ...
const MENU: [string, string, string, number, [string, number][]][] = [
  ['Chicken kabsa', 'كبسة دجاج', 'Mains', 38, [['CHK', 0.3], ['RIC', 0.2], ['SPC', 0.01]]], ['Lamb mandi', 'مندي لحم', 'Mains', 62, [['LMB', 0.35], ['RIC', 0.22], ['SPC', 0.01]]],
  ['Grilled chicken', 'دجاج مشوي', 'Mains', 41, [['CHK', 0.35], ['OLV', 0.02], ['LMN', 0.03]]], ['Beef burger', 'برجر لحم', 'Mains', 34, [['BEF', 0.18], ['BRD', 1], ['CHS', 0.03], ['TOM', 0.04]]],
  ['Grilled fish', 'سمك مشوي', 'Mains', 58, [['FSH', 0.3], ['LMN', 0.04], ['OLV', 0.02]]], ['Mixed grill', 'مشاوي مشكلة', 'Mains', 76, [['LMB', 0.2], ['CHK', 0.2], ['BEF', 0.1]]],
  ['Chicken shawarma', 'شاورما دجاج', 'Mains', 19, [['CHK', 0.15], ['BRD', 1], ['YOG', 0.03]]], ['Lamb shawarma', 'شاورما لحم', 'Mains', 24, [['LMB', 0.15], ['BRD', 1], ['YOG', 0.03]]],
  ['Fried potatoes plate', 'بطاطس مقلية', 'Mains', 14, [['POT', 0.3], ['OIL', 0.04]]], ['Vegetable stew', 'يخنة خضار', 'Mains', 27, [['POT', 0.15], ['TOM', 0.1], ['ONI', 0.06]]],
  ['Hummus', 'حمص', 'Starters', 15, [['HUM', 0.12], ['OLV', 0.01], ['LMN', 0.02]]], ['Moutabal', 'متبل', 'Starters', 16, [['YOG', 0.05], ['OLV', 0.01], ['LMN', 0.02]]],
  ['Fattoush salad', 'سلطة فتوش', 'Starters', 18, [['LET', 0.08], ['TOM', 0.06], ['CUC', 0.06], ['BRD', 0.5]]], ['Garden salad', 'سلطة خضراء', 'Starters', 16, [['LET', 0.1], ['TOM', 0.08], ['CUC', 0.08]]],
  ['Lentil soup', 'شوربة عدس', 'Starters', 14, [['ONI', 0.04], ['OIL', 0.01], ['SPC', 0.004]]], ['Cheese sambousek', 'سمبوسة جبن', 'Starters', 17, [['FLR', 0.06], ['CHS', 0.05], ['OIL', 0.03]]],
  ['Meat sambousek', 'سمبوسة لحم', 'Starters', 19, [['FLR', 0.06], ['BEF', 0.05], ['OIL', 0.03]]], ['Tabbouleh', 'تبولة', 'Starters', 17, [['TOM', 0.08], ['LMN', 0.03], ['OLV', 0.01]]],
  ['Arabic coffee', 'قهوة عربية', 'Drinks', 9, [['COF', 0.012], ['SGR', 0.005]]], ['Cappuccino', 'كابتشينو', 'Drinks', 16, [['COF', 0.018], ['MLK', 0.18]]], ['Flat white', 'فلات وايت', 'Drinks', 17, [['COF', 0.02], ['MLK', 0.15]]],
  ['Karak tea', 'شاي كرك', 'Drinks', 8, [['TEA', 0.006], ['MLK', 0.12], ['SGR', 0.01]]], ['Fresh lemon mint', 'ليمون بالنعناع', 'Drinks', 14, [['LMN', 0.12], ['SGR', 0.02]]], ['Laban', 'لبن', 'Drinks', 7, [['YOG', 0.25]]],
  ['Fresh orange juice', 'عصير برتقال', 'Drinks', 15, [['SGR', 0.005]]], ['Iced coffee', 'قهوة مثلجة', 'Drinks', 18, [['COF', 0.02], ['MLK', 0.2]]],
  ['Kunafa', 'كنافة', 'Desserts', 22, [['CHS', 0.08], ['SGR', 0.04], ['FLR', 0.05]]], ['Umm Ali', 'أم علي', 'Desserts', 20, [['MLK', 0.2], ['SGR', 0.03], ['CRM', 0.05]]],
  ['Date pudding', 'بودينغ تمر', 'Desserts', 19, [['DAT', 0.08], ['CRM', 0.05], ['FLR', 0.04]]], ['Rice pudding', 'مهلبية', 'Desserts', 14, [['MLK', 0.2], ['SGR', 0.03], ['RIC', 0.03]]],
];

/** Kitchen materials in stock and a menu with recipes. Returns the recipe ids by name. */
async function restaurantMenu(c: Ctx, menuSize: number, supplier: string): Promise<Record<string, string>> {
  const items: Record<string, string> = {};
  for (const [sku, name, nameAr, , reorder] of MATERIALS) items[sku] = await Inv.saveItem(c.db, c.id, { sku, name, nameAr, unit: ['MLK', 'OIL', 'OLV', 'YOG'].includes(sku) ? 'l' : ['BRD', 'EGG'].includes(sku) ? 'pcs' : 'kg', reorderLevel: String(reorder) });
  await note(c, 'grn', 45, supplier, MATERIALS.map(([sku, , , cost]) => ({ itemId: items[sku]!, quantity: '2500', unitCost: cost.toFixed(2) })), 'Opening delivery');
  const recipes: Record<string, string> = {};
  for (const [name, nameAr, category, price, lines] of MENU.slice(0, menuSize)) {
    recipes[name] = await Rest.saveRecipe(c.db, c.id, { name, nameAr, category, salePrice: price.toFixed(2), lines: lines.map(([sku, q]) => ({ itemId: items[sku]!, quantity: String(q) })) });
  }
  return recipes;
}

/** Food sales across the last `days` days: a few a day, busier on weekends. */
async function foodSales(c: Ctx, recipes: Record<string, string>, days: number, perDay: [number, number], accounts: { cash: string; card: string }) {
  const names = Object.keys(recipes);
  for (let d = days; d >= 1; d--) {
    const weekend = [5, 6].includes(new Date(daysAgo(d) + 'T00:00:00Z').getUTCDay());
    for (let s = 0; s < c.int(perDay[0], perDay[1]) + (weekend ? 2 : 0); s++) {
      const method = c.r() < 0.55 ? 'card' : 'cash';
      await Rest.sellFood(c.db, c.id, { date: daysAgo(d), method, accountId: method === 'card' ? accounts.card : accounts.cash, costCentreId: c.cc['Head office'],
        lines: Array.from({ length: c.int(3, 6) }, () => ({ recipeId: recipes[c.pick(names)]!, quantity: c.int(1, 4) })) });
    }
  }
}

// ------------------------------------------------------------------ Al Zaytoon Café
export async function zaytoon(c: Ctx): Promise<Facts> {
  await opening(c, 210000, 9000);
  const sellers = businessNames(c.r, 5, 'seller');
  const suppliers: string[] = [];
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 300 + i, 14));
  const recipes = await restaurantMenu(c, 30, suppliers[0]!);
  await foodSales(c, recipes, 30, [22, 30], { cash: c.acct['1010']!, card: c.acct['1000']! });
  await runningCosts(c, 14000, [1800, 3400], [{ supplier: suppliers[0]!, what: 'Weekly food delivery', code: '2050', range: [6200, 9800], n: 3 }, { supplier: suppliers[1]!, what: 'Packaging and consumables', code: '5400', range: [900, 2600], n: 3 }], [25]);
  await staff(c, 8, [['Cashier', 3000, 4200], ['Waiter', 2600, 3400], ['Barista', 3200, 4500], ['Cook', 3500, 5200], ['Kitchen helper', 2200, 2800], ['Shift supervisor', 5500, 7200]], undefined, 1);
  await fixedAssets(c, [{ name: 'Espresso machine', nameAr: 'ماكينة إسبريسو', code: '1500', bought: 520, cost: 24000, residual: 2000, life: 60 }, { name: 'Walk-in fridge', nameAr: 'ثلاجة غرفة', code: '1500', bought: 700, cost: 31000, residual: 3000, life: 84 },
    { name: 'Dining furniture', nameAr: 'أثاث قاعة الطعام', code: '1520', bought: 600, cost: 46000, life: 84 }, { name: 'Point of sale tablets', nameAr: 'أجهزة نقاط البيع', code: '1530', bought: 300, cost: 7800, life: 36 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.4);
  return { bankId };
}

// ------------------------------------------------------------------ Corniche Resort
export async function corniche(c: Ctx): Promise<Facts> {
  await opening(c, 980000, 40000);
  const sellers = businessNames(c.r, 6, 'seller');
  const suppliers: string[] = [];
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 400 + i, 21));
  const agencies = businessNames(c.r, 4, 'hotel');
  const agencyIds: string[] = [];
  for (const [i, n] of agencies.entries()) agencyIds.push(await c.contact('customer', n, 450 + i, 30));

  // Rooms: 24 rooms in three types, a winter season on the sea-view rate.
  const std = await Room.saveType(c.db, c.id, { code: 'STD', name: 'Standard room', nameAr: 'غرفة عادية', capacity: 2, rate: '395.00' });
  const dlx = await Room.saveType(c.db, c.id, { code: 'DLX', name: 'Deluxe sea view', nameAr: 'ديلوكس بإطلالة بحرية', capacity: 3, rate: '690.00' });
  const ste = await Room.saveType(c.db, c.id, { code: 'STE', name: 'Family suite', nameAr: 'جناح عائلي', capacity: 5, rate: '1180.00' });
  await Room.saveSeason(c.db, c.id, { typeId: dlx, name: 'Winter season', from: daysAgo(-20), to: daysAgo(-60), rate: '815.00' });
  await Room.saveSeason(c.db, c.id, { typeId: std, name: 'Winter season', from: daysAgo(-20), to: daysAgo(-60), rate: '455.00' });
  const room: Record<string, string> = {};
  const layout: [string, string, string][] = [
    ...['101', '102', '103', '104', '105', '106', '107', '108'].map((n) => [n, std, '1'] as [string, string, string]),
    ...['201', '202', '203', '204'].map((n) => [n, std, '2'] as [string, string, string]),
    ...['205', '206', '207', '208', '301', '302', '303', '304'].map((n) => [n, dlx, n.startsWith('2') ? '2' : '3'] as [string, string, string]),
    ...['401', '402', '403', '404'].map((n) => [n, ste, '4'] as [string, string, string]),
  ];
  for (const [n, t, fl] of layout) room[n] = await Room.saveRoom(c.db, c.id, { number: n, typeId: t, floor: fl });
  const g = (name: string, phone: string) => ({ name, phone });
  const cash = c.acct['1000']!;
  // Fifteen bookings this month: guests in house, arrivals today, stays billed, bookings ahead, one cancelled.
  const busy: Record<string, [number, number][]> = {};
  const stay = async (guest: { name: string; phone: string } | null, contactId: string | null, roomNo: string, arr: number, dep: number, o: { adults?: number; children?: number; source?: string; checkedIn?: boolean; out?: boolean } = {}) => {
    const id = await Room.createBooking(c.db, c.id, { ...(guest ? { guest } : { contactId }), roomId: room[roomNo], arrival: daysAgo(arr), departure: daysAgo(dep), adults: o.adults ?? 2, children: o.children, source: o.source ?? 'Website' } as never);
    if (o.checkedIn || o.out) await Room.checkIn(c.db, id, daysAgo(arr));
    (busy[roomNo] ??= []).push([dep, arr]);
    return id;
  };
  const past = [
    ['Khalid Al-Harbi', '0500000101', '205', 19, 16], ['Mia Andersson', '0500000102', '101', 17, 14], ['Omar Haddad', '0500000103', '302', 15, 12], ['Elena Petrova', '0500000104', '402', 13, 10], ['Yousef Al-Dossari', '0500000105', '106', 12, 9],
  ] as const;
  for (const [n, ph, rm, a, d] of past) {
    const b = await stay(g(n, ph), null, rm, a, d, { out: true });
    await Room.addExtra(c.db, b, { date: daysAgo(a - 1), description: 'Laundry', quantity: '2', unitPrice: '23.00' });
    const inv = await Room.checkOut(c.db, b, { day: daysAgo(d) });
    if (inv) { const guest = (await c.client.query('SELECT contact_id FROM documents WHERE id = $1', [inv])).rows[0].contact_id as string; await c.payFull('received', guest, inv, d, '1000', 'card'); }
  }
  const bill = await stay(g('Mona Al-Zahrani', '0500000106'), null, '206', 3, -2, { children: 1, source: 'Phone', checkedIn: true });
  await Room.addExtra(c.db, bill, { date: daysAgo(2), description: 'Restaurant · dinner for 3', quantity: '1', unitPrice: '247.00' });
  await Room.addExtra(c.db, bill, { date: daysAgo(2), description: 'Breakfast buffet', quantity: '3', unitPrice: '69.00' });
  await Room.addExtra(c.db, bill, { date: daysAgo(1), description: 'Restaurant · lunch', quantity: '1', unitPrice: '186.00' });
  await Room.addExtra(c.db, bill, { date: daysAgo(1), description: 'Laundry', quantity: '4', unitPrice: '23.00' });
  await Room.addExtra(c.db, bill, { date: daysAgo(0), description: 'Mini bar', quantity: '2', unitPrice: '18.00' });
  await Room.takeDeposit(c.db, bill, { amount: '500.00', date: daysAgo(3), accountId: cash, method: 'card' });
  await stay(g('Peter Lindqvist', '0500000107'), null, '103', 2, -1, { source: 'Travel agent', checkedIn: true });
  await stay(g('Sami Haddad', '0500000108'), null, '301', 1, -3, { adults: 1, source: 'Walk-in', checkedIn: true });
  await stay(g('Reem Al-Qahtani', '0500000109'), null, '104', 0, -2, { adults: 1 });
  await stay(g('Anna Weber', '0500000110'), null, '403', 0, -4, { adults: 2, children: 2 });
  const team = await stay(null, agencyIds[0]!, '404', -4, -8, { adults: 4, source: 'Email' });
  await Room.takeAdvance(c.db, team, { amount: '1500.00', date: daysAgo(1), accountId: cash, method: 'bank_transfer', reference: 'TT-55821' });
  await stay(g('Fatima Al-Anazi', '0500000111'), null, '207', -3, -6, { source: 'Phone' });
  await stay(g('David Okafor', '0500000112'), null, '304', -6, -9, { adults: 1, source: 'Website' });
  const off = await stay(g('Hind Al-Subaie', '0500000113'), null, '208', -1, -4);
  await Room.cancel(c.db, off);
  // Bookings ahead over the next fortnight, so the calendar is busy.
  const clash = (rm: string, a: number, d: number) => (busy[rm] ?? []).some(([d2, a2]) => Math.max(d, d2) < Math.min(a, a2));
  const names = SAUDI_NAMES(c.r, 40);
  let nameIx = 0;
  for (const rm of Object.keys(room)) {
    if (rm === '208') continue;
    let a = -c.int(0, 4);
    while (a > -17) {
      const d = a - c.int(2, 4);
      if (!clash(rm, a, d) && c.r() < 0.8) {
        await c.client.query('SAVEPOINT fut');
        try { await stay(g(names[nameIx % names.length]![0], `0500002${String(nameIx).padStart(3, '0')}`), null, rm, a, d, { adults: c.int(1, 3), source: c.pick(['Website', 'Phone', 'Travel agent', 'Email']) }); await c.client.query('RELEASE SAVEPOINT fut'); nameIx++; } catch { await c.client.query('ROLLBACK TO SAVEPOINT fut'); }
      }
      a = d - c.int(0, 2);
    }
  }

  // The restaurant: menu, materials and a month of food sales.
  const recipes = await restaurantMenu(c, 14, suppliers[0]!);
  await foodSales(c, recipes, 30, [9, 13], { cash: c.acct['1010']!, card: cash });
  for (let k = 0; k < 8; k++) {
    const id = await c.doc('invoice', agencyIds[k % 4]!, 80 - k * 9, 30, [c.SL(['Conference hall hire', 'Wedding reception package', 'Corporate retreat package', 'Banquet dinner'][k % 4]!, '1', c.money(32000, 62000), 'Head office')]);
    if (k < 6) await c.payFull('received', agencyIds[k % 4]!, id, Math.max(1, 80 - k * 9 - c.int(5, 20)));
  }
  await runningCosts(c, 20000, [4500, 7500], [{ supplier: suppliers[0]!, what: 'Kitchen supplies', code: '2050', range: [9800, 17400], n: 3 }, { supplier: suppliers[1]!, what: 'Linen and laundry service', code: '5400', range: [3100, 6800], n: 4 }, { supplier: suppliers[2]!, what: 'Maintenance contract', code: '5400', range: [2200, 5600], n: 3 }]);
  await staff(c, 12, [['Front desk agent', 4200, 5800], ['Housekeeper', 2300, 2900], ['Chef', 6500, 9500], ['Waiter', 2700, 3500], ['Maintenance technician', 3600, 4800], ['Security officer', 3000, 3600], ['Duty manager', 9000, 12500]]);
  await fixedAssets(c, [{ name: 'Air conditioning units', nameAr: 'وحدات تكييف', code: '1500', bought: 900, cost: 210000, residual: 20000, life: 120 }, { name: 'Hotel furniture', nameAr: 'أثاث الفندق', code: '1520', bought: 800, cost: 160000, life: 84 },
    { name: 'Property management computers', nameAr: 'أجهزة إدارة الفندق', code: '1530', bought: 350, cost: 21500, life: 36 }, { name: 'Airport shuttle van', nameAr: 'حافلة نقل المطار', code: '1510', bought: 500, cost: 98000, residual: 18000, life: 60 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.3);
  return { bankId, bookingId: bill };
}

// ------------------------------------------------------------------ Najd Contracting
const SITE_MATERIALS: [string, string, string, string, number, number][] = [
  ['CEM', 'Cement 50kg bag', 'أسمنت 50 كجم', 'bag', 18, 4000], ['RBR', 'Rebar 16mm', 'حديد تسليح 16 مم', 'ton', 2480, 60], ['BLK', 'Concrete block 20cm', 'بلوك أسمنتي', 'pcs', 3.1, 30000], ['SND', 'Washed sand', 'رمل مغسول', 'm3', 42, 300],
  ['GRV', 'Gravel 20mm', 'حصى', 'm3', 55, 260], ['PNT', 'Exterior paint 18L', 'دهان خارجي', 'drum', 285, 90], ['PPE', 'PVC pipe 4in', 'ماسورة بلاستيك', 'pcs', 36, 600], ['CBL', 'Electrical cable 2.5mm', 'كابل كهربائي', 'roll', 195, 120],
  ['TIL', 'Floor tiles 60x60', 'بلاط أرضيات', 'm2', 44, 2400], ['PLY', 'Plywood 18mm', 'خشب رقائقي', 'sheet', 76, 300], ['NAL', 'Nails 3in', 'مسامير', 'box', 14, 150], ['INS', 'Insulation board', 'عازل حراري', 'sheet', 33, 500],
  ['DOR', 'Steel door', 'باب حديد', 'pcs', 520, 40], ['WIN', 'Aluminium window', 'نافذة ألمنيوم', 'pcs', 640, 40], ['GYP', 'Gypsum board', 'ألواح جبس', 'sheet', 21, 900], ['ELB', 'Electrical breaker panel', 'لوحة قواطع', 'pcs', 410, 35],
];

export async function najd(c: Ctx): Promise<Facts> {
  await opening(c, 760000, 22000);
  const buyers = businessNames(c.r, 6, 'buyer'), sellers = businessNames(c.r, 6, 'seller');
  const customers: string[] = [], suppliers: string[] = [];
  for (const [i, n] of buyers.entries()) customers.push(await c.contact('customer', n, 500 + i, 45));
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 520 + i, 30));

  // Four projects with budgets; one is close to its limit.
  const proj: Record<string, string> = {};
  const defs: [string, string, number, number, number, string][] = [
    ['Narjis Villa Compound', 'مجمع فلل النرجس', 1450000, 62, 0.58, customers[0]!], ['Logistics Warehouse, Phase 2', 'مستودع لوجستي – المرحلة الثانية', 2100000, 48, 0.46, customers[1]!],
    ['Tuwaiq School Extension', 'توسعة مدرسة طويق', 860000, 90, 0.71, customers[2]!], ['Retail Fit-out, Olaya', 'تجهيز محل تجاري – العليا', 380000, 40, 0.93, customers[3]!],
  ];
  for (const [name, nameAr, budget, start, , contact] of defs) {
    proj[name] = await saveProject(c.db, c.id, { name, nameAr, contactId: contact, budget: budget.toFixed(2), startDate: daysAgo(start) });
    c.cc[name] = proj[name]!;
  }
  for (const [name, , budget, start, used, contact] of defs) {
    const spend = budget * used;
    const parts = 5;
    for (let k = 0; k < parts; k++) {
      const supplier = suppliers[k % suppliers.length]!;
      const amount = (spend / parts) * (0.8 + c.r() * 0.4) / 1.0;
      const ago = Math.max(2, start - 4 - k * Math.floor(start / (parts + 1)));
      const id = await c.doc('bill', supplier, ago, 30, [c.SL(['Concrete and steel works', 'Subcontractor: electrical', 'Subcontractor: plumbing', 'Finishing materials', 'Equipment transport'][k]!, '1', (amount / 1.15).toFixed(2), name, '5000')], { reference: `SUB-${c.int(2000, 9000)}` });
      if (k < parts - 1) await c.payFull('made', supplier, id, Math.max(1, ago - c.int(10, 25)));
    }
    // Progress invoices to the client, partly paid.
    const billed = budget * (used + 0.30);
    const inv1 = await c.doc('invoice', contact, Math.round(start * 0.6), 45, [c.SL(`${name}: progress claim 1`, '1', (billed * 0.55 / 1.15).toFixed(2), name)], { reference: `IPC-${c.int(10, 99)}` });
    await c.payFull('received', contact, inv1, Math.max(1, Math.round(start * 0.35)));
    await c.doc('invoice', contact, Math.max(3, Math.round(start * 0.2)), 45, [c.SL(`${name}: progress claim 2`, '1', (billed * 0.45 / 1.15).toFixed(2), name)], { reference: `IPC-${c.int(100, 199)}` });
  }

  // Materials, delivered to the sites.
  const items: Record<string, string> = {};
  for (const [sku, name, nameAr, unit, price, reorder] of SITE_MATERIALS) items[sku] = await Inv.saveItem(c.db, c.id, { sku, name, nameAr, unit, reorderLevel: String(Math.round(reorder * 0.2)) });
  await note(c, 'grn', 100, suppliers[0]!, SITE_MATERIALS.map(([sku, , , , price, reorder]) => ({ itemId: items[sku]!, quantity: String(reorder), unitCost: price.toFixed(2) })), 'GRN-9001');
  for (const [k, [name]] of defs.entries()) {
    await note(c, 'gdn', 30 - k * 5, null, SITE_MATERIALS.slice(k * 3, k * 3 + 5).map(([sku, , , , , reorder]) => ({ itemId: items[sku]!, quantity: String(Math.round(reorder * 0.25)), costCentreId: proj[name] })), `SITE-${k + 1}`, '5000');
  }
  await note(c, 'gdn', 6, null, SITE_MATERIALS.slice(8, 14).map(([sku, , , , , reorder]) => ({ itemId: items[sku]!, quantity: String(Math.round(reorder * 0.3)), costCentreId: proj['Tuwaiq School Extension'] })), 'SITE-9', '5000');

  // Hire equipment and five contracts in different states.
  const eq = async (code: string, name: string, nameAr: string, category: string, id_: string, rates: { dayRate?: string; weekRate?: string; monthRate?: string; hourRate?: string }, units = 1) =>
    Rent.saveItem(c.db, c.id, { code, name, nameAr, category, identifier: id_, units, ...rates });
  const crane = await eq('CR-50', 'Mobile crane 50t', 'رافعة متحركة 50 طن', 'Crane', 'Plate 4821', { dayRate: '1500.00', hourRate: '350.00', monthRate: '30000.00' });
  const scaf = await eq('SC-FR', 'Scaffolding frames', 'سقالات', 'Scaffolding', 'Store A', { dayRate: '2.50', weekRate: '12.00' }, 800);
  const gen1 = await eq('GN-100', 'Generator 100 kVA', 'مولد 100 كيلو فولت أمبير', 'Generator', 'GN-100-A', { dayRate: '400.00', weekRate: '2400.00' });
  const gen2 = await eq('GN-60', 'Generator 60 kVA', 'مولد 60 كيلو فولت أمبير', 'Generator', 'GN-60-B', { dayRate: '260.00', weekRate: '1500.00' });
  const lift = await eq('TH-12', 'Telehandler 12m', 'رافعة تلسكوبية', 'Lifting', 'TH-4410', { dayRate: '780.00', weekRate: '4600.00' });
  const truck = await eq('PK-04', 'Pickup truck 4x4', 'بيك أب دفع رباعي', 'Vehicle', 'Plate 7120', { dayRate: '220.00', monthRate: '4200.00' });
  const k1 = await Rent.saveContract(c.db, c.id, { contactId: customers[4]!, site: 'Riyadh Metro, station 4', reference: 'PO-778', costCentreId: proj['Narjis Villa Compound'] });
  await Rent.addLine(c.db, k1, { itemId: crane, basis: 'day', outDate: daysAgo(20) });
  await issueDocument(c.db, await Rent.bill(c.db, k1, daysAgo(7)));
  const k2 = await Rent.saveContract(c.db, c.id, { contactId: customers[5]!, site: 'Dammam Industrial City', reference: 'PO-802' });
  await Rent.addLine(c.db, k2, { itemId: scaf, basis: 'week', units: 400, outDate: daysAgo(14) });
  await Rent.addLine(c.db, k2, { itemId: gen1, basis: 'week', outDate: daysAgo(10) });
  const k3 = await Rent.saveContract(c.db, c.id, { contactId: customers[2]!, site: 'Tuwaiq School', reference: 'PO-815' });
  const l3 = await Rent.addLine(c.db, k3, { itemId: lift, basis: 'day', outDate: daysAgo(9) });
  await Rent.returnLine(c.db, l3, daysAgo(1));
  const k4 = await Rent.saveContract(c.db, c.id, { contactId: customers[3]!, site: 'Olaya retail unit', reference: 'PO-790' });
  const l4 = await Rent.addLine(c.db, k4, { itemId: truck, basis: 'month', outDate: daysAgo(50) });
  await Rent.returnLine(c.db, l4, daysAgo(20));
  const inv4 = await Rent.bill(c.db, k4, daysAgo(20));
  await issueDocument(c.db, inv4);
  await c.payFull('received', customers[3]!, inv4, 8);
  await Rent.closeContract(c.db, k4);
  const k5 = await Rent.saveContract(c.db, c.id, { contactId: customers[0]!, site: 'Narjis Villa Compound', reference: 'PO-830' });
  await Rent.addLine(c.db, k5, { itemId: gen2, basis: 'day', outDate: daysAgo(-3) });
  void k5;

  await runningCosts(c, 36000, [2800, 5200], [{ supplier: suppliers[4]!, what: 'Site consumables', code: '5400', range: [2400, 6100], n: 3 }]);
  await staff(c, 20, [['Site engineer', 7800, 11500], ['Foreman', 4500, 6200], ['Laborer', 1600, 2200], ['Crane operator', 4200, 5600], ['Surveyor', 6500, 8800], ['Storekeeper', 3200, 4000], ['Accountant', 6800, 9000], ['Driver', 2400, 3200]], 'Head office');
  await fixedAssets(c, [{ name: 'Excavator', nameAr: 'حفارة', code: '1500', bought: 1100, cost: 420000, residual: 60000, life: 96 }, { name: 'Concrete mixer truck', nameAr: 'خلاطة خرسانة', code: '1510', bought: 900, cost: 310000, residual: 40000, life: 84 },
    { name: 'Survey instruments', nameAr: 'أجهزة مساحة', code: '1500', bought: 600, cost: 68000, life: 60 }, { name: 'Site office cabins', nameAr: 'كبائن مكتب الموقع', code: '1500', bought: 700, cost: 96000, residual: 8000, life: 120 },
    { name: 'Company vehicles', nameAr: 'مركبات الشركة', code: '1510', bought: 450, cost: 185000, residual: 30000, life: 60 }, { name: 'Office computers', nameAr: 'أجهزة المكتب', code: '1530', bought: 300, cost: 31000, life: 36 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.4);
  return { bankId, contractId: k1, contract2Id: k2 };
}

// ------------------------------------------------------------------ Riyadh Mart
const RETAIL: Record<string, { ar: string; items: [string, number][] }> = {
  Beverages: { ar: 'مشروبات', items: [['Bottled water 330ml', 0.9], ['Bottled water 1.5L', 1.8], ['Orange juice 1L', 7.5], ['Apple juice 1L', 7.5], ['Cola 330ml', 2.4], ['Lemon soda 330ml', 2.4], ['Energy drink', 6.5], ['Iced tea 500ml', 3.9], ['Mango nectar 1L', 8.2], ['Sparkling water', 2.7], ['Instant coffee 200g', 29], ['Black tea 100 bags', 16.5], ['Arabic coffee 250g', 33], ['Milk shake 250ml', 4.7], ['Malt drink', 4.1]] },
  Snacks: { ar: 'وجبات خفيفة', items: [['Potato chips 70g', 2.9], ['Cheese crackers', 3.5], ['Chocolate bar', 3.2], ['Biscuits assorted', 5.4], ['Salted peanuts', 6.8], ['Dates box 500g', 18.5], ['Gum', 2.1], ['Popcorn', 4.2], ['Granola bar', 3.6], ['Halawa 200g', 9.9], ['Dried apricots 250g', 14.5], ['Pistachio 200g', 26], ['Wafer rolls', 3.1], ['Jelly candy', 2.8], ['Mixed nuts 300g', 28]] },
  Dairy: { ar: 'ألبان', items: [['Fresh milk 1L', 6.2], ['Yoghurt 500g', 4.4], ['Laban 1L', 5.1], ['Cheddar cheese 200g', 11.5], ['Feta cheese 400g', 14.9], ['Butter 200g', 13.5], ['Cream cheese 200g', 9.3], ['Labneh 400g', 8.4], ['Eggs tray 30', 17.5], ['Cooking cream 250ml', 6.4], ['Cheese slices 12', 8.8], ['Condensed milk', 5.2], ['Ghee 500g', 24], ['Flavoured milk', 3.3], ['Powdered milk 900g', 42]] },
  Bakery: { ar: 'مخبوزات', items: [['Arabic bread 6pc', 2.5], ['Toast bread', 4.9], ['Croissant', 3.3], ['Samoli bread', 3.1], ['Cake slice', 7.5], ['Date cookies', 9.5], ['Flatbread', 2.2], ['Burger buns 6', 5.6], ['Muffin', 3.9], ['Baguette', 2.9], ['Cream rolls', 4.5], ['Sesame bread', 3.4], ['Pizza dough', 8.2], ['Brioche', 4.6], ['Tea cake', 12]] },
  Cleaning: { ar: 'منظفات', items: [['Dish liquid 750ml', 8.5], ['Laundry powder 3kg', 31], ['Floor cleaner 1L', 11.5], ['Bleach 1L', 6.5], ['Glass cleaner', 9.8], ['Trash bags 30', 7.9], ['Paper towels 2', 8.9], ['Toilet tissue 12', 19.5], ['Sponge pack', 4.8], ['Air freshener', 12.5], ['Hand soap', 7.2], ['Fabric softener 2L', 17.9], ['Disinfectant', 13.4], ['Laundry liquid 2L', 28], ['Drain cleaner', 11.8]] },
  'Personal care': { ar: 'عناية شخصية', items: [['Shampoo 400ml', 17.5], ['Conditioner 400ml', 17.5], ['Body wash 500ml', 15.9], ['Toothpaste 100ml', 9.5], ['Toothbrush', 6.4], ['Deodorant', 14.8], ['Razor pack', 21], ['Hand cream', 12.5], ['Face wipes', 10.9], ['Hair oil', 19.9], ['Soap bar 4', 9.2], ['Cotton pads', 6.7], ['Perfume mist', 28], ['Lip balm', 7.4], ['Sunscreen', 32]] },
  Grocery: { ar: 'مواد غذائية', items: [['Basmati rice 5kg', 46], ['Sugar 2kg', 8.5], ['Flour 2kg', 7.2], ['Cooking oil 1.5L', 15.8], ['Pasta 500g', 4.6], ['Tomato paste', 3.7], ['Canned tuna', 8.1], ['Chickpeas can', 4.2], ['Salt 1kg', 2.1], ['Black pepper', 9.6], ['Honey 500g', 38], ['Tahini 400g', 17.4], ['Lentils 1kg', 9.9], ['Oats 500g', 11.7], ['Olive oil 500ml', 32]] },
  Stationery: { ar: 'قرطاسية', items: [['Notebook A5', 6.5], ['Ballpoint pens 10', 8.9], ['Marker set', 13.5], ['Stapler', 11.5], ['Printer paper 500', 22], ['Glue stick', 3.4], ['Scissors', 7.9], ['Folder', 2.8], ['Sticky notes', 5.6], ['Calculator', 24], ['Highlighters 4', 9.4], ['Envelopes 25', 6.2], ['Tape roll', 3.9], ['Clipboard', 9.7], ['Pencil case', 8.5]] },
};

export async function rmart(c: Ctx): Promise<Facts> {
  await opening(c, 430000, 26000);
  const sellers = businessNames(c.r, 6, 'seller');
  const suppliers: string[] = [];
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 600 + i, 21));
  const customerNames = SAUDI_NAMES(c.r, 40);
  const customers: string[] = [];
  for (const [i, n] of customerNames.entries()) customers.push(await saveContact(c.db, c.id, { isCustomer: true, name: n[0], nameAr: n[1], phone: `05${i % 10} 000 ${String(1000 + i * 37).slice(0, 4)}`, country: 'SA', city: 'Riyadh', paymentTermsDays: 0 }));
  const walkIn = await saveContact(c.db, c.id, { isCustomer: true, name: 'Walk-in customer', nameAr: 'عميل نقدي', country: 'SA', paymentTermsDays: 0 });

  const items: { id: string; name: string; price: number; qty: number; reorder: number }[] = [];
  for (const [cat, def] of Object.entries(RETAIL)) {
    for (const [i, [name, price]] of def.items.entries()) {
      const reorder = c.int(12, 40);
      const id = await Inv.saveItem(c.db, c.id, { sku: `${cat.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`, name, nameAr: name, unit: 'pcs', salePrice: price.toFixed(2), reorderLevel: String(reorder) });
      items.push({ id, name, price, reorder, qty: reorder * c.int(4, 10) });
    }
  }
  await note(c, 'grn', 75, suppliers[0]!, items.map((it) => ({ itemId: it.id, quantity: String(it.qty), unitCost: (it.price * (0.66 + c.r() * 0.1)).toFixed(2) })), 'GRN-2201');

  // A simplified invoice for every day's counter sales, paid at once; some account customers buy on credit.
  for (let d = 30; d >= 1; d--) {
    const lines = Array.from({ length: c.int(32, 46) }, () => { const it = c.pick(items); return c.SL(it.name, String(c.int(4, 22)), it.price.toFixed(2), 'Head office'); });
    const id = await c.doc('invoice', walkIn, d, 0, lines, { reference: `POS-${daysAgo(d).replaceAll('-', '')}` });
    const method = d % 3 === 0 ? 'cash' : 'card';
    await c.payFull('received', walkIn, id, d, method === 'cash' ? '1010' : '1000', method);
  }
  for (let k = 0; k < 10; k++) {
    const cu = customers[k * 3]!;
    const lines = Array.from({ length: c.int(2, 5) }, () => { const it = c.pick(items); return c.SL(it.name, String(c.int(3, 24)), it.price.toFixed(2), 'Head office'); });
    const id = await c.doc('invoice', cu, c.int(3, 28), 14, lines);
    if (k % 3 !== 0) await c.payFull('received', cu, id, c.int(1, 3));
  }
  for (const [k, group] of [items.slice(0, 40), items.slice(40, 80), items.slice(80, 120)].entries()) {
    const out = group.filter((_, i) => i % 3 === k).map((it) => { const q = Math.max(1, it.qty - Math.floor(it.reorder * (0.4 + c.r() * 0.4))); it.qty -= q; return { itemId: it.id, quantity: String(q), costCentreId: c.cc['Head office'] }; });
    await note(c, 'gdn', 4 + k * 3, walkIn, out, `ISS-${300 + k}`, '5000');
  }
  await runningCosts(c, 24000, [3200, 5800], [{ supplier: suppliers[1]!, what: 'Weekly stock purchase', code: '5000', range: [8500, 19500], n: 5 }, { supplier: suppliers[2]!, what: 'Refrigeration service', code: '5400', range: [900, 2400], n: 2 }], [25]);
  await fixedAssets(c, [{ name: 'Shop shelving', nameAr: 'أرفف المتجر', code: '1520', bought: 800, cost: 58000, life: 84 }, { name: 'Refrigerated display cases', nameAr: 'ثلاجات عرض', code: '1500', bought: 650, cost: 74000, residual: 6000, life: 84 },
    { name: 'Point of sale terminals', nameAr: 'أجهزة نقاط البيع', code: '1530', bought: 320, cost: 12600, life: 36 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.4);
  return { bankId };
}

// ------------------------------------------------------------------ Desert Rose Consulting
export async function rose(c: Ctx): Promise<Facts> {
  await opening(c, 380000, 8000);
  const buyers = businessNames(c.r, 10, 'buyer'), sellers = businessNames(c.r, 3, 'seller');
  const customers: string[] = [], suppliers: string[] = [];
  for (const [i, n] of buyers.entries()) customers.push(await c.contact('customer', n, 700 + i, 30));
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 720 + i, 21));

  // Five client projects with budgets (costs are subcontractors and travel).
  const projects: [string, string, number, number][] = [['ERP selection study', 'دراسة اختيار نظام تخطيط', 180000, 70], ['Process redesign, finance', 'إعادة تصميم العمليات المالية', 240000, 55], ['Market entry report', 'تقرير دخول السوق', 95000, 40],
    ['Compliance review', 'مراجعة الامتثال', 130000, 30], ['Training programme', 'برنامج تدريبي', 72000, 20]];
  const pj: string[] = [];
  for (const [i, [name, nameAr, budget, start]] of projects.entries()) {
    const id = await saveProject(c.db, c.id, { name, nameAr, contactId: customers[i]!, budget: budget.toFixed(2), startDate: daysAgo(start) });
    c.cc[name] = id; pj.push(id);
    const bill = await c.doc('bill', suppliers[i % suppliers.length]!, Math.max(3, start - 5), 21, [c.SL('Subcontracted analysts and travel', '1', (budget * (0.1 + c.r() * 0.18)).toFixed(2), name, '5400')]);
    if (i % 2 === 0) await c.payFull('made', suppliers[i % suppliers.length]!, bill, 2);
    const inv = await c.doc('invoice', customers[i]!, Math.max(2, Math.round(start * 0.5)), 30, [c.SL(`${name}: milestone 1`, '1', (budget * 0.55).toFixed(2), name)]);
    await c.payFull('received', customers[i]!, inv, 1);
    await c.doc('invoice', customers[i]!, Math.max(1, Math.round(start * 0.2)), 30, [c.SL(`${name}: milestone 2`, '1', (budget * 0.35).toFixed(2), name)]);
  }
  // Twelve quotations, some accepted.
  const qStatus = ['accepted', 'accepted', 'sent', 'sent', 'accepted', 'declined', 'sent', 'sent', 'accepted', 'sent', 'declined', 'sent'] as const;
  for (let k = 0; k < 12; k++) {
    const id = await saveDraft(c.db, c.id, { type: 'quotation', contactId: customers[k % customers.length]!, issueDate: daysAgo(70 - k * 5), reference: `PROP-${210 + k}`,
      lines: [c.SL(['Strategy workshop (3 days)', 'Financial model build', 'Operating model review', 'Policy and procedure manual', 'Management training', 'Due diligence support'][k % 6]!, '1', c.money(18000, 96000), undefined)] });
    await setQuotationStatus(c.db, id, qStatus[k]!);
  }
  // Six recurring retainer invoices.
  const retainers: [string, number][] = [['Monthly CFO advisory', 14500], ['Quarterly board pack', 9200], ['Payroll and WPS service', 6800], ['Monthly bookkeeping review', 4300], ['Compliance calendar service', 3900], ['Training subscription', 5600]];
  for (const [k, [name, amount]] of retainers.entries()) {
    await saveRecurringInvoice(c.db, c.id, { name, contactId: customers[(k + 2) % customers.length], frequency: 'monthly', nextDate: daysAgo(-(3 + k * 4)), termsDays: 30, mode: 'draft',
      lines: [{ description: name, quantity: '1', unitPrice: amount.toFixed(2), accountId: c.acct['4000'], vatCode: 'standard' }] });
  }
  // CRM: ten leads across the stages, deals at each stage.
  const camp = await Crm.saveCampaign(c.db, c.id, { name: 'Finance leaders breakfast', channel: 'event', startDate: daysAgo(45), endDate: daysAgo(40), budget: '6000.00', status: 'done', audience: 'CFOs in Riyadh and Jeddah' });
  const leadNames = businessNames(c.r, 10, 'buyer');
  const statuses = ['new', 'new', 'contacted', 'contacted', 'qualified', 'qualified', 'qualified', 'lost', 'new', 'contacted'] as const;
  const leads: string[] = [];
  for (const [i, n] of leadNames.entries()) leads.push(await Crm.saveLead(c.db, c.id, { name: n[0], nameAr: n[1], contactPerson: SAUDI_NAMES(c.r, 1)[0]![0], phone: `05${i} 000 ${1100 + i * 91}`, campaignId: camp, estimatedValue: c.money(12000, 90000), ownerId: c.poster, status: statuses[i], ...(statuses[i] === 'lost' ? { lostReason: 'Budget frozen' } : {}) } as never));
  const stages = ['new', 'qualified', 'negotiation', 'negotiation', 'qualified', 'won', 'won', 'lost', 'new', 'qualified', 'negotiation', 'new'] as const;
  for (const [i, st] of stages.entries()) {
    await Crm.saveDeal(c.db, c.id, { title: ['ERP support retainer', 'Finance transformation', 'Budgeting tool rollout', 'Audit readiness', 'Investor deck and model', 'Training academy'][i % 6]!, contactId: customers[i % customers.length]!, value: c.money(24000, 150000), stage: st, expectedClose: daysAgo(-(10 + i * 6)), ownerId: c.poster,
      ...(st === 'lost' ? { lostReason: 'Went with an in-house team' } : {}) } as never);
  }
  await Crm.saveActivity(c.db, c.id, { kind: 'call', subject: 'Follow up on proposal', dueDate: daysAgo(0), ownerId: c.poster, leadId: leads[4] });
  await Crm.saveActivity(c.db, c.id, { kind: 'meeting', subject: 'Scoping meeting', dueDate: daysAgo(-2), dueTime: '10:30', ownerId: c.poster, leadId: leads[5] });
  await runningCosts(c, 22000, [1800, 3400], [{ supplier: suppliers[2]!, what: 'Software subscriptions', code: '5400', range: [2800, 6200], n: 3 }]);
  await staff(c, 10, [['Senior consultant', 14000, 19500], ['Consultant', 8500, 12500], ['Analyst', 5500, 8000], ['Project coordinator', 5200, 7000], ['Office manager', 4800, 6200]]);
  await fixedAssets(c, [{ name: 'Office computers', nameAr: 'أجهزة المكتب', code: '1530', bought: 380, cost: 62000, life: 36 }, { name: 'Office furniture', nameAr: 'أثاث المكتب', code: '1520', bought: 600, cost: 48000, life: 84 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.4);
  return { bankId };
}

// ------------------------------------------------------------------ Eastern Fabrication
const RAW: [string, string, string, string, number, number][] = [
  ['SH2', 'Steel sheet 2mm', 'لوح حديد 2 مم', 'sheet', 285, 140], ['SH4', 'Steel sheet 4mm', 'لوح حديد 4 مم', 'sheet', 540, 110], ['SH6', 'Steel sheet 6mm', 'لوح حديد 6 مم', 'sheet', 790, 90], ['AL3', 'Aluminium sheet 3mm', 'لوح ألمنيوم 3 مم', 'sheet', 410, 60],
  ['TUB', 'Square tube 40x40', 'ماسورة مربعة', 'pcs', 74, 400], ['PIP', 'Round pipe 2in', 'ماسورة دائرية', 'pcs', 68, 380], ['ANG', 'Angle bar 50x50', 'زاوية حديد', 'pcs', 58, 350], ['FLT', 'Flat bar 40x5', 'حديد مسطح', 'pcs', 41, 300],
  ['RD1', 'Round bar 16mm', 'حديد دائري', 'pcs', 49, 260], ['BLT', 'Bolts M12 box', 'براغي', 'box', 36, 220], ['NUT', 'Nuts M12 box', 'صواميل', 'box', 22, 220], ['WLD', 'Welding rods 5kg', 'أسلاك لحام', 'box', 87, 180],
  ['PRM', 'Primer paint 18L', 'دهان أساسي', 'drum', 255, 60], ['PNT', 'Finish paint 18L', 'دهان نهائي', 'drum', 340, 60], ['BRG', 'Bearings set', 'مجموعة رولمان', 'set', 195, 50], ['HNG', 'Heavy hinges', 'مفصلات ثقيلة', 'pcs', 28, 300],
  ['WHL', 'Caster wheels', 'عجلات', 'pcs', 33, 240], ['GAS', 'Welding gas cylinder', 'غاز لحام', 'pcs', 145, 40], ['CUT', 'Cutting discs box', 'أقراص قطع', 'box', 62, 120], ['GRN', 'Grinding discs box', 'أقراص جلخ', 'box', 58, 120],
];
const FINISHED: [string, string, string, number][] = [
  ['GTE', 'Steel entrance gate', 'بوابة حديد', 2400], ['FNC', 'Fence panel 2m', 'لوح سياج', 380], ['WTK', 'Water tank 1000L', 'خزان مياه', 1450], ['BRK', 'Wall bracket set', 'مجموعة حوامل', 95], ['STR', 'Steel staircase', 'درج حديد', 5800],
  ['RCK', 'Warehouse racking bay', 'رف مستودع', 1950], ['DOR', 'Security door', 'باب أمان', 1680], ['CNP', 'Car park canopy', 'مظلة مواقف', 7400], ['TRL', 'Steel trolley', 'عربة حديد', 640], ['WKB', 'Workshop bench', 'طاولة ورشة', 890],
  ['PLT', 'Base plates', 'صفائح قاعدة', 120], ['CHM', 'Chimney flue', 'مدخنة', 1120], ['FRM', 'Structural frame bay', 'هيكل إنشائي', 8900], ['GRL', 'Handrail 3m', 'درابزين', 520], ['SHD', 'Roller shutter', 'باب رول', 1380], ['LDR', 'Roof access ladder', 'سلم سطح', 760], ['MZZ', 'Mezzanine floor panel', 'لوح ميزانين', 1580], ['PLM', 'Pipe supports', 'حوامل مواسير', 210], ['SGN', 'Sign frame', 'إطار لوحة', 470], ['CTR', 'Cable tray 3m', 'حامل كابلات', 160],
];

export async function eastern(c: Ctx): Promise<Facts> {
  await opening(c, 820000, 15000);
  const buyers = businessNames(c.r, 8, 'buyer'), sellers = businessNames(c.r, 5, 'seller');
  const customers: string[] = [], suppliers: string[] = [];
  for (const [i, n] of buyers.entries()) customers.push(await c.contact('customer', n, 800 + i, 45));
  for (const [i, n] of sellers.entries()) suppliers.push(await c.contact('supplier', n, 820 + i, 30));

  // 40 materials and finished goods in the store.
  const items: Record<string, { id: string; price: number; qty: number; reorder: number }> = {};
  for (const [sku, name, nameAr, unit, price, qty] of RAW) { const reorder = Math.round(qty * 0.18); items[sku] = { id: await Inv.saveItem(c.db, c.id, { sku, name, nameAr, unit, reorderLevel: String(reorder) }), price, qty, reorder }; }
  for (const [sku, name, nameAr, price] of FINISHED) { const reorder = c.int(2, 6); items[`F-${sku}`] = { id: await Inv.saveItem(c.db, c.id, { sku: `F-${sku}`, name, nameAr, unit: 'pcs', salePrice: price.toFixed(2), reorderLevel: String(reorder) }), price: price * 0.62, qty: reorder * c.int(6, 12) + 8, reorder }; }
  await note(c, 'grn', 100, suppliers[0]!, Object.values(items).map((it) => ({ itemId: it.id, quantity: String(it.qty), unitCost: it.price.toFixed(2) })), 'GRN-6100');
  // Four production jobs tracked as projects, with materials issued to them.
  const jobs: [string, string, number, number][] = [['Job 214: gates and fences, Jubail', 'أمر 214: بوابات وأسوار', 210000, 0.64], ['Job 219: storage racking, Dammam', 'أمر 219: رفوف تخزين', 340000, 0.52], ['Job 221: canopy structures', 'أمر 221: مظلات', 150000, 0.88], ['Job 226: tank fabrication', 'أمر 226: تصنيع خزانات', 275000, 0.31]];
  const jp: string[] = [];
  for (const [i, [name, nameAr, budget, used]] of jobs.entries()) {
    const id = await saveProject(c.db, c.id, { name, nameAr, contactId: customers[i]!, budget: budget.toFixed(2), startDate: daysAgo(60 - i * 8) });
    c.cc[name] = id; jp.push(id);
    await note(c, 'gdn', 40 - i * 7, null, RAW.slice(i * 4, i * 4 + 5).map(([sku]) => ({ itemId: items[sku]!.id, quantity: String(Math.round(items[sku]!.qty * 0.14)), costCentreId: id })), `JOB-${214 + i}`, '5000');
    const bill = await c.doc('bill', suppliers[i % suppliers.length]!, 35 - i * 4, 30, [c.SL('Subcontract machining and coating', '1', (budget * used * 0.25).toFixed(2), name, '5000')]);
    if (i % 2 === 0) await c.payFull('made', suppliers[i % suppliers.length]!, bill, 3);
    const inv = await c.doc('invoice', customers[i]!, 30 - i * 3, 45, [c.SL(`${name}: first delivery`, '1', (budget * 0.45).toFixed(2), name)]);
    if (i < 2) await c.payFull('received', customers[i]!, inv, 2);
    await c.doc('invoice', customers[i]!, Math.max(1, 12 - i * 2), 45, [c.SL(`${name}: second delivery`, '1', (budget * 0.4).toFixed(2), name)]);
  }
  // Finished goods sold from stock.
  const fin = Object.entries(items).filter(([k]) => k.startsWith('F-'));
  for (let k = 0; k < 12; k++) {
    const cu = customers[k % customers.length]!;
    const lines = [fin[(k * 3) % fin.length]!, fin[(k * 3 + 1) % fin.length]!].map(([sku, it]) => ({ sku, it, q: c.int(1, 3) }));
    const id = await c.doc('invoice', cu, 80 - k * 6, 30, lines.map(({ sku, it, q }) => c.SL(FINISHED.find((f) => `F-${f[0]}` === sku)![1], String(q), (it.price / 0.62).toFixed(2), 'Head office')));
    await note(c, 'gdn', 80 - k * 6, cu, lines.map(({ it, q }) => ({ itemId: it.id, quantity: String(q), costCentreId: c.cc['Head office'] })), `DN-${7000 + k}`);
    if (k % 3 !== 2) await c.payFull('received', cu, id, Math.max(1, 80 - k * 6 - c.int(10, 30)));
  }
  // Warehouse counter issues against a job today.
  await note(c, 'gdn', 1, null, RAW.slice(10, 15).map(([sku]) => ({ itemId: items[sku]!.id, quantity: '6', costCentreId: jp[1] })), 'JOB-219-B', '5000');
  await runningCosts(c, 28000, [6800, 11500], [{ supplier: suppliers[2]!, what: 'Coating and galvanising', code: '5000', range: [8200, 18800], n: 4 }, { supplier: suppliers[3]!, what: 'Workshop consumables', code: '5400', range: [1900, 4800], n: 3 }]);
  await staff(c, 25, [['Welder', 2600, 3800], ['Fabricator', 2400, 3400], ['Machine operator', 3000, 4400], ['Painter', 2000, 2700], ['Quality inspector', 5200, 7200], ['Production planner', 7000, 9800], ['Storekeeper', 3000, 3800], ['Driver', 2300, 3000], ['Supervisor', 6200, 8200]]);
  await fixedAssets(c, [{ name: 'CNC plasma cutter', nameAr: 'ماكينة قطع بلازما', code: '1500', bought: 1000, cost: 520000, residual: 60000, life: 96 }, { name: 'Press brake 200t', nameAr: 'ماكينة ثني 200 طن', code: '1500', bought: 1200, cost: 380000, residual: 40000, life: 120 },
    { name: 'MIG welding machine A', nameAr: 'ماكينة لحام أ', code: '1500', bought: 700, cost: 38000, life: 60 }, { name: 'MIG welding machine B', nameAr: 'ماكينة لحام ب', code: '1500', bought: 480, cost: 41000, life: 60 },
    { name: 'Lathe', nameAr: 'مخرطة', code: '1500', bought: 1300, cost: 145000, residual: 12000, life: 120 }, { name: 'Forklift 3t', nameAr: 'رافعة شوكية', code: '1510', bought: 900, cost: 92000, residual: 14000, life: 84 },
    { name: 'Air compressor', nameAr: 'ضاغط هواء', code: '1500', bought: 650, cost: 27000, life: 84 }, { name: 'Overhead crane 10t', nameAr: 'رافعة علوية', code: '1500', bought: 1500, cost: 330000, residual: 30000, life: 144 }]);
  await fileDeadlines(c);
  const bankId = await bankStatement(c, 0.4);
  return { bankId };
}
void businessNames; void saveContact;
