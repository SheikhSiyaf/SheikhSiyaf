// Inventory (items, goods received and delivery notes, stock value) and fixed asset routes.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { dateParam, uuidParam, type Ctx } from './context.js';
import * as I from '../books/inventoryService.js';
import * as F from '../books/assetsService.js';
import * as R from '../books/restaurantService.js';
import { today } from './context.js';

async function member(db: Db, companyId: string) {
  const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new HttpError(404, 'Not found.', 'err.notFound');
}
type P = { id: string };
const noteType = (t: unknown) => (t === 'grn' || t === 'gdn' ? t : (() => { throw new HttpError(404, 'Not found.', 'err.notFound'); })());

export function registerStockRoutes(app: FastifyInstance, { as }: Ctx) {
  const inCompany = <T>(req: Parameters<Ctx['as']>[0], id: string, fn: (db: Db, companyId: string) => Promise<T>) => {
    const companyId = uuidParam(id);
    return as(req, async (db) => { await member(db, companyId); return fn(db, companyId); });
  };
  const ok = { ok: true };
  const companyOf = async (db: Db, table: 'items' | 'stock_notes' | 'fixed_assets', id: string) => {
    const r = (await db.query(`SELECT company_id FROM ${table} WHERE id = $1`, [uuidParam(id)])).rows[0];
    if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
    return r.company_id as string;
  };

  // items
  app.get<{ Params: P; Querystring: { q?: string } }>('/api/companies/:id/items', async (req) => inCompany(req, req.params.id, (db, c) => I.listItems(db, c, req.query.q ?? '')));
  app.post<{ Params: P; Body: I.ItemInput }>('/api/companies/:id/items', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await I.saveItem(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/items/:id', async (req) => as(req, (db) => I.getItem(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: I.ItemInput }>('/api/items/:id', async (req) => as(req, async (db) => ({ id: await I.saveItem(db, await companyOf(db, 'items', req.params.id), req.body ?? {}, req.params.id) })));
  app.get<{ Params: P }>('/api/companies/:id/stock-value', async (req) => inCompany(req, req.params.id, (db, c) => I.stockValue(db, c)));

  // goods notes
  app.get<{ Params: P; Querystring: { type?: string; q?: string; manual?: string } }>('/api/companies/:id/stock-notes', async (req) =>
    inCompany(req, req.params.id, (db, c) => I.listNotes(db, c, noteType(req.query.type), req.query.q ?? '', req.query.manual === '1')));
  app.post<{ Params: P; Body: I.NoteInput }>('/api/companies/:id/stock-notes', async (req) =>
    inCompany(req, req.params.id, async (db, c) => ({ id: await I.saveNoteDraft(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/stock-notes/:id', async (req) => as(req, (db) => I.getNote(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: I.NoteInput }>('/api/stock-notes/:id', async (req) =>
    as(req, async (db) => ({ id: await I.saveNoteDraft(db, await companyOf(db, 'stock_notes', req.params.id), req.body ?? {}, req.params.id) })));
  app.post<{ Params: P }>('/api/stock-notes/:id/post', async (req) => as(req, async (db) => { await I.postNote(db, uuidParam(req.params.id)); return ok; }));
  app.post<{ Params: P }>('/api/stock-notes/:id/delete', async (req) => as(req, async (db) => { await I.deleteNoteDraft(db, uuidParam(req.params.id)); return ok; }));

  // restaurant: menu items (recipes) and food sales
  app.get<{ Params: P; Querystring: { q?: string } }>('/api/companies/:id/recipes', async (req) => inCompany(req, req.params.id, (db, c) => R.listRecipes(db, c, req.query.q ?? '')));
  app.post<{ Params: P; Body: R.RecipeInput }>('/api/companies/:id/recipes', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await R.saveRecipe(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/recipes/:id', async (req) => as(req, (db) => R.getRecipe(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: R.RecipeInput }>('/api/recipes/:id', async (req) => as(req, async (db) => {
    const r = (await db.query('SELECT company_id FROM recipes WHERE id = $1', [uuidParam(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, 'Not found.', 'err.notFound');
    return { id: await R.saveRecipe(db, r.company_id, req.body ?? {}, req.params.id) };
  }));
  app.post<{ Params: P; Body: R.SaleInput }>('/api/companies/:id/restaurant/sales', async (req) => inCompany(req, req.params.id, (db, c) => R.sellFood(db, c, req.body ?? {})));
  app.get<{ Params: P; Querystring: { from?: string; to?: string } }>('/api/companies/:id/restaurant/sales', async (req) =>
    inCompany(req, req.params.id, (db, c) => { const to = dateParam(req.query.to, today()); return R.listSales(db, c, dateParam(req.query.from, to), to); }));

  // fixed assets
  app.get<{ Params: P; Querystring: { q?: string } }>('/api/companies/:id/assets', async (req) => inCompany(req, req.params.id, (db, c) => F.listAssets(db, c, req.query.q ?? '')));
  app.post<{ Params: P; Body: F.AssetInput }>('/api/companies/:id/assets', async (req) => inCompany(req, req.params.id, async (db, c) => ({ id: await F.saveAsset(db, c, req.body ?? {}) })));
  app.get<{ Params: P }>('/api/companies/:id/asset-summary', async (req) => inCompany(req, req.params.id, (db, c) => F.registerSummary(db, c)));
  app.get<{ Params: P }>('/api/assets/:id', async (req) => as(req, (db) => F.getAsset(db, uuidParam(req.params.id))));
  app.post<{ Params: P; Body: F.AssetInput }>('/api/assets/:id', async (req) =>
    as(req, async (db) => ({ id: await F.saveAsset(db, await companyOf(db, 'fixed_assets', req.params.id), req.body ?? {}, req.params.id) })));
  app.post<{ Params: P; Body: F.DisposalInput }>('/api/assets/:id/dispose', async (req) => as(req, async (db) => ({ entryId: await F.disposeAsset(db, uuidParam(req.params.id), req.body ?? {}) })));
  app.get<{ Params: P }>('/api/companies/:id/depreciation', async (req) => inCompany(req, req.params.id, async (db, c) => ({ next: await F.nextRunMonth(db, c), runs: await F.listRuns(db, c) })));
  app.get<{ Params: P; Querystring: { periodEnd?: string } }>('/api/companies/:id/depreciation/preview', async (req) =>
    inCompany(req, req.params.id, (db, c) => F.previewRun(db, c, dateParam(req.query.periodEnd, ''))));
  app.post<{ Params: P; Body: { periodEnd?: string } }>('/api/companies/:id/depreciation/run', async (req) =>
    inCompany(req, req.params.id, (db, c) => F.runDepreciation(db, c, dateParam(req.body?.periodEnd, ''))));
}
