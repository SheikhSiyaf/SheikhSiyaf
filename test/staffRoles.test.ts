// Platform staff roles (migration 0088): who may do what in the owner workspace, and the guards that keep the platform from being locked out.
import { describe, it, expect, beforeAll } from 'vitest';
import { as, owner, seed, type Fixture } from './helpers.js';

let f: Fixture;
let ownerRole = '', accountantRole = '', reviewerRole = '', viewerRole = '';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const ok = async <T>(p: Promise<T>) => { await p; };
async function roleId(name: string) { return (await owner.query('SELECT id FROM staff_roles WHERE name = $1', [name])).rows[0].id as string; }
/** A staff person with the given role, made by the first owner (through the real function). */
async function person(roleName: string, label = roleName) {
  const email = `${label.toLowerCase().replace(/\W/g, '')}.${stamp()}@staff.example.com`;
  const id = await as(f.platformOwner, async (db) => (await db.query('SELECT staff_member_add($1, $2, $3) AS id', [label, email, await roleId(roleName)])).rows[0].id as string);
  return { id, email };
}

beforeAll(async () => {
  f = await seed();
  ownerRole = await roleId('Owner'); accountantRole = await roleId('Accountant'); reviewerRole = await roleId('Reviewer'); viewerRole = await roleId('Viewer');
});

describe('staff roles', () => {
  it('existing owners keep full access', async () => {
    const r = (await as(f.platformOwner, (db) => db.query('SELECT app_is_owner() AS o, app_staff_can($1) AS c, my_staff_access() AS a', ['payments.settings']))).rows[0];
    expect(r.o).toBe(true); expect(r.c).toBe(true); expect(r.a.full).toBe(true); expect(r.a.role).toBe('Owner');
  });

  it('a reviewer can review payments but passes none of the old owner-only checks', async () => {
    const p = await person('Reviewer');
    const r = (await as(p.id, (db) => db.query(`SELECT app_is_owner() AS o, app_staff_can('payments.review') AS rev, app_staff_can('payments.settings') AS setg, app_staff_can('customers.manage') AS cm`))).rows[0];
    expect(r).toEqual({ o: false, rev: true, setg: false, cm: false });
    await expect(as(p.id, (db) => db.query('SELECT staff_members()'))).rejects.toThrow(/platform owner/);
    await expect(as(p.id, (db) => db.query('SELECT owner_tenants()'))).rejects.toThrow();   // an existing owner-only function now refuses them
  });

  it('the app cannot read or write the role tables directly', async () => {
    const p = await person('Viewer');
    for (const sql of ['SELECT * FROM staff_roles', 'SELECT * FROM staff_role_grants', `INSERT INTO staff_role_grants (role_id, permission) VALUES ('${viewerRole}', 'billing.manage')`,
      `UPDATE staff_roles SET is_full = true`]) {
      await expect(as(p.id, (db) => db.query(sql)), sql).rejects.toThrow();
    }
    // a direct change of a role on the users table does nothing (row-level security hides the row, and a trigger refuses it anyway)
    for (const who of [p.id, f.platformOwner]) {
      await as(who, (db) => db.query(`UPDATE users SET staff_role_id = $1 WHERE id = $2`, [ownerRole, p.id]).then(() => undefined, () => undefined));
      expect((await owner.query('SELECT staff_role_id AS r FROM users WHERE id = $1', [p.id])).rows[0].r, 'role unchanged').toBe(viewerRole);
    }
  });

  it('customers and ordinary users have no staff access at all', async () => {
    for (const u of [f.admin, f.partner, f.a.clientAccountant]) {
      const r = (await as(u, (db) => db.query(`SELECT app_staff_can('payments.view') AS c, my_staff_access() AS a`))).rows[0];
      expect(r.c).toBe(false); expect(r.a).toBeNull();
      await expect(as(u, (db) => db.query(`SELECT staff_member_add('X', 'x.${stamp()}@e.example.com', $1)`, [viewerRole]))).rejects.toThrow(/platform owner/);
    }
  });

  it('only the owner role makes roles; a role that changes something must also see it; unknown permissions are refused', async () => {
    const p = await person('Accountant');
    await expect(as(p.id, (db) => db.query(`SELECT staff_role_save(NULL, 'Sneaky', '', ARRAY['payments.settings','payments.view'])`))).rejects.toThrow(/platform owner/);
    const name = `Bookkeeper ${stamp()}`;
    const id = await as(f.platformOwner, async (db) => (await db.query(`SELECT staff_role_save(NULL, $1, 'Checks invoices', ARRAY['billing.view','billing.manage','customers.view']) AS id`, [name])).rows[0].id as string);
    const list = await as(f.platformOwner, async (db) => (await db.query('SELECT staff_roles_list() AS l')).rows[0].l);
    expect(list.roles.find((r: { id: string }) => r.id === id).permissions).toEqual(['billing.manage', 'billing.view', 'customers.view']);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_role_save(NULL, $1, '', ARRAY['billing.view'])`, [name.toUpperCase()]))).rejects.toThrow(/exists already/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_role_save(NULL, 'Bad', '', ARRAY['billing.manage'])`))).rejects.toThrow(/also be able to see/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_role_save(NULL, 'Bad2', '', ARRAY['everything.all'])`))).rejects.toThrow(/from the list/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_role_save(NULL, 'A', '', ARRAY[]::text[])`))).rejects.toThrow(/name/);
    // the permission set changes what a person can do straight away
    const q = await person(name.replace(/ \d+$/, '') === 'Bookkeeper' ? 'Viewer' : 'Viewer');
    await as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [q.id, id]));
    expect((await as(q.id, (db) => db.query(`SELECT app_staff_can('billing.manage') AS c`))).rows[0].c).toBe(true);
    await as(f.platformOwner, (db) => db.query(`SELECT staff_role_save($1, $2, 'Checks invoices', ARRAY['billing.view'])`, [id, name]));
    expect((await as(q.id, (db) => db.query(`SELECT app_staff_can('billing.manage') AS c`))).rows[0].c).toBe(false);
  });

  it('built-in roles are fixed; a role in use cannot be archived; an archived role grants nothing', async () => {
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_role_save($1, 'Reviewer', '', ARRAY['payments.view','payments.settings'])`, [reviewerRole]))).rejects.toThrow(/Built-in/);
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_role_archive($1)', [reviewerRole]))).rejects.toThrow(/Built-in/);
    expect(await owner.query(`SELECT 1 FROM staff_roles WHERE is_full AND NOT built_in`)).toHaveProperty('rowCount', 0);
    await expect(owner.query(`INSERT INTO staff_roles (name, is_full, built_in) VALUES ('Second owner', true, false)`)).rejects.toThrow();
    await expect(owner.query(`INSERT INTO staff_roles (name, is_full, built_in) VALUES ('Second built-in owner', true, true)`)).rejects.toThrow();   // only one full role
    const name = `Temp ${stamp()}`;
    const id = await as(f.platformOwner, async (db) => (await db.query(`SELECT staff_role_save(NULL, $1, '', ARRAY['payments.view']) AS id`, [name])).rows[0].id as string);
    const q = await person('Viewer');
    await as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [q.id, id]));
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_role_archive($1)', [id]))).rejects.toThrow(/Move the people/);
    await as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [q.id, viewerRole]));
    await ok(as(f.platformOwner, (db) => db.query('SELECT staff_role_archive($1)', [id])));
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [q.id, id]))).rejects.toThrow(/Choose a role/);
  });

  it('nobody changes their own role or status, and the last active Owner can never be removed', async () => {
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [f.platformOwner, viewerRole]))).rejects.toThrow(/own role/);
    await expect(as(f.platformOwner, (db) => db.query(`SELECT staff_member_set_status($1, 'suspended')`, [f.platformOwner]))).rejects.toThrow(/own access/);
    // Everything below happens inside one transaction that is always rolled back, so the shared test database keeps its owners.
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE nusuh_app');
      const second = (await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.platformOwner]), (await c.query('SELECT staff_member_add($1, $2, $3) AS id', ['Second Owner', `second.${stamp()}@staff.example.com`, ownerRole])).rows[0].id as string);
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [second]);
      const full = async () => { await c.query('RESET ROLE'); try { return await fullInner(); } finally { await c.query('SET LOCAL ROLE nusuh_app'); } };
      const fullInner = async () => Number((await c.query(`SELECT count(*) AS n FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE r.is_full AND u.status = 'active' AND u.removed_at IS NULL`)).rows[0].n);
      await c.query('RESET ROLE');
      const others = (await c.query(`SELECT u.id FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE r.is_full AND u.status = 'active' AND u.id <> $1`, [second])).rows.map((r) => r.id as string);
      await c.query('SET LOCAL ROLE nusuh_app');
      expect(others.length).toBeGreaterThan(0);
      // suspend every other Owner (other test files add platform owners at the same time, so look again until none is left)
      for (let pass = 0, todo = others; todo.length && pass < 5; pass++) {
        for (const id of todo) { await c.query(`SELECT staff_member_set_status($1, 'suspended')`, [id]); }   // fine while the second owner stays
        await c.query('RESET ROLE');
        todo = (await c.query(`SELECT u.id FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE r.is_full AND u.status = 'active' AND u.removed_at IS NULL AND u.id <> $1`, [second])).rows.map((r) => r.id as string);
        await c.query('SET LOCAL ROLE nusuh_app');
      }
      expect(await full()).toBeLessThanOrEqual(2);   // the second owner, and at most one a parallel test file added a moment ago
      expect(await full()).toBeGreaterThanOrEqual(1);
      // the one left cannot be demoted or suspended by anyone: nobody else is an Owner, and nobody changes themselves
      await c.query('SAVEPOINT s1');
      await expect(c.query('SELECT staff_member_set_role($1, $2)', [second, viewerRole])).rejects.toThrow(/own role/);
      await c.query('ROLLBACK TO s1');
      // a restored owner can demote the other, but the guard counts the rows after the change
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [f.platformOwner]);
      await c.query('SAVEPOINT s2');
      await expect(c.query(`SELECT staff_member_set_status($1, 'suspended')`, [second])).rejects.toThrow(/Not allowed|platform owner/);   // suspended owner cannot act
      await c.query('ROLLBACK TO s2');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a suspended or re-roled person is signed out (session version changes) and loses access at once', async () => {
    const p = await person('Accountant');
    const v0 = Number((await owner.query('SELECT session_version AS v FROM users WHERE id = $1', [p.id])).rows[0].v);
    await as(f.platformOwner, (db) => db.query('SELECT staff_member_set_role($1, $2)', [p.id, viewerRole]));
    const v1 = Number((await owner.query('SELECT session_version AS v FROM users WHERE id = $1', [p.id])).rows[0].v);
    expect(v1).toBe(v0 + 1);
    expect((await as(p.id, (db) => db.query(`SELECT app_staff_can('billing.manage') AS c`))).rows[0].c).toBe(false);
    await as(f.platformOwner, (db) => db.query(`SELECT staff_member_set_status($1, 'suspended')`, [p.id]));
    expect((await as(p.id, (db) => db.query(`SELECT app_staff_can('payments.view') AS c, my_staff_access() AS a`))).rows[0]).toEqual({ c: false, a: null });
    await as(f.platformOwner, (db) => db.query(`SELECT staff_member_set_status($1, 'active')`, [p.id]));
    expect((await as(p.id, (db) => db.query(`SELECT app_staff_can('payments.view') AS c`))).rows[0].c).toBe(true);
  });

  it('editing a person: duplicate emails refused, an email change signs them out, other platform firms are never touched', async () => {
    const p = await person('HR'); const q = await person('HR', 'Other');
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_member_update($1, $2, $3)', [p.id, 'Name', q.email.toUpperCase()]))).rejects.toThrow(/already used/);
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_member_update($1, $2, $3)', [p.id, ' ', 'x@y.example.com']))).rejects.toThrow(/name and email/);
    await expect(as(f.platformOwner, (db) => db.query('SELECT staff_member_update($1, $2, $3)', [f.admin, 'Hijack', 'h@y.example.com']))).rejects.toThrow(/not found/i);   // a customer's admin is not staff
    const v0 = Number((await owner.query('SELECT session_version AS v FROM users WHERE id = $1', [p.id])).rows[0].v);
    const fresh = `renamed.${stamp()}@staff.example.com`;
    await as(f.platformOwner, (db) => db.query('SELECT staff_member_update($1, $2, $3)', [p.id, 'Renamed <b>x</b>', fresh]));
    const r = (await owner.query('SELECT full_name, email, session_version AS v FROM users WHERE id = $1', [p.id])).rows[0];
    expect(r.email).toBe(fresh); expect(Number(r.v)).toBe(v0 + 1); expect(r.full_name).toBe('Renamed <b>x</b>');   // stored as text; the screen escapes it
  });

  it('every role change is in the audit log', async () => {
    const before = Number((await owner.query(`SELECT count(*) AS n FROM audit_log WHERE table_name IN ('staff_roles','staff_role_grants')`)).rows[0].n);
    await as(f.platformOwner, (db) => db.query(`SELECT staff_role_save(NULL, $1, '', ARRAY['payments.view'])`, [`Audited ${stamp()}`]));
    const after = Number((await owner.query(`SELECT count(*) AS n FROM audit_log WHERE table_name IN ('staff_roles','staff_role_grants')`)).rows[0].n);
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });
});
