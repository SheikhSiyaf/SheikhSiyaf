// Rooms (hospitality): the front desk (arrivals, departures, guests in house), the calendar of rooms and nights,
// bookings with check-in and check-out, extras and the guest bill, and the setup (room types, seasons, rooms).
// Rates and extras are prices with VAT; the bill shows any halala difference to the quoted price.
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { api, useApi, type CompanyBooks } from '../api.ts';
import { useI18n, useLocalName, type Key } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { today } from '../router.ts';
import { ErrorNote, Loading, errorText } from '../ui.tsx';
import { useGo, type Contact } from '../sales/common.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { addDays, groupNights, nights as nightsOf, nightsLine } from '../../../src/books/rooms.ts';

type Status = 'reserved' | 'in_house' | 'departed' | 'cancelled' | 'no_show';
interface Season { id: string; typeId: string; name: string | null; from: string; to: string; rate: string }
interface RoomType { id: string; code: string; name: string; nameAr: string | null; capacity: number; rate: string; incomeAccountId: string; incomeAccountCode: string;
  status: 'active' | 'retired'; notes: string | null; rooms: number; seasons: Season[] }
interface Room { id: string; number: string; typeId: string; typeCode: string; typeName: string; typeNameAr: string | null; capacity: number; rate: string; floor: string | null;
  status: 'active' | 'out_of_service' | 'retired'; notes: string | null }
interface BookingRow { id: string; number: string; status: Status; contactId: string; guest: string; guestAr: string | null; phone: string | null; guestVat: string | null;
  roomId: string; room: string; typeName: string; typeNameAr: string | null; arrival: string; departure: string; nights: number; adults: number; children: number;
  agreedRate: string | null; source: string | null; reference: string | null; notes: string | null; billedTo: string | null }
interface Charge { description: string; quantity: string; unitPrice: string; quoted: string; total: string; difference: string }
interface Booking extends BookingRow {
  extras: { id: string; date: string; description: string; quantity: string; unitPrice: string; billed: boolean }[];
  bills: { id: string; documentId: string; nightsFrom: string; nightsTo: string; number: string | null; status: string; total: string }[];
  unbilled: { lines: Charge[]; quoted: string; total: string; difference: string } | null;
}
interface FrontDesk { day: string; arrivals: BookingRow[]; notArrived: BookingRow[]; departures: BookingRow[]; inHouse: BookingRow[]; rooms: number; outOfService: number;
  occupied: number; occupancy: number }
interface Cal { from: string; to: string; nights: number; rooms: Room[]; bookings: { id: string; number: string; status: Status; roomId: string; guest: string; arrival: string; departure: string }[] }

const TONE: Record<Status, string> = { reserved: '', in_house: 'warn', departed: 'good', cancelled: '', no_show: 'bad' };
function useRun() {
  const { t, has } = useI18n();
  const [msg, setMsg] = useState<{ ok?: string; bad?: string }>({});
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(true); setMsg({});
    try { await fn(); if (ok) setMsg({ ok }); after?.(); } catch (e) { setMsg({ bad: errorText(t, has, e) }); } finally { setBusy(false); }
  };
  return { run, busy, note: <>{msg.ok && <div className="notice">{msg.ok}</div>}{msg.bad && <div className="notice bad" role="alert">{msg.bad}</div>}</> };
}
const StatusBadge = ({ s }: { s: Status }) => { const { t } = useI18n(); return <span className={`badge ${TONE[s]}`}>{t(`room.st.${s}` as Key)}</span>; };

export function Rooms({ books, sub, item }: { books: CompanyBooks; sub?: string; item?: string }) {
  const canEdit = books.canPost && accessTo(books.access?.permissions, 'Rooms') === 'edit';
  if (sub === 'room-calendar') return <CalendarPage books={books} canEdit={canEdit} />;
  if (sub === 'bookings') return item === 'new' ? <NewBooking books={books} /> : item ? <BookingPage key={item} books={books} id={item} canEdit={canEdit} /> : <Bookings books={books} canEdit={canEdit} />;
  if (sub === 'room-setup') return <Setup books={books} canEdit={canEdit} />;
  return <Desk books={books} canEdit={canEdit} />;
}

// ------------------------------------------------------------------ front desk
function Desk({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const d = useApi<FrontDesk>(`/api/companies/${books.company.id}/rooms/front-desk`);
  const { run, busy, note } = useRun();
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const fig = (label: string, value: string | number, sub: string) => <div className="card fig"><small>{label}</small><b>{value}</b><small>{sub}</small></div>;
  const list = (title: string, rows: BookingRow[], action?: (b: BookingRow) => ReactElement | null) => (
    <div className="card">
      <h2>{title} <span className="mut small">({rows.length})</span></h2>
      {rows.length === 0 ? <div className="mut">{t('room.none')}</div> : (
        <div className="wrap"><table className="stack"><tbody>{rows.map((b) => (
          <tr key={b.id}>
            <td><button className="link" onClick={() => go('Rooms', 'bookings', b.id)}>{local(b.guest, b.guestAr)}</button><div className="small mut ltr">{b.number}</div></td>
            <td data-label={t('room.room')}><b>{b.room}</b> <span className="small mut">{local(b.typeName, b.typeNameAr)}</span></td>
            <td className="ltr small" data-label={t('room.dates')}>{b.arrival} → {b.departure}</td>
            <td className="num">{action?.(b)}</td>
          </tr>))}</tbody></table></div>
      )}
    </div>
  );
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('room.deskHint')}</div>
      {note}
      <div className="grid">
        {fig(t('room.occupancy'), `${x.occupancy}%`, t('room.occupiedN', { n: x.occupied, total: x.rooms }))}
        {fig(t('room.arrivals'), x.arrivals.length, t('room.notArrivedN', { n: x.notArrived.length }))}
        {fig(t('room.inHouse'), x.inHouse.length, t('room.departuresN', { n: x.departures.length }))}
      </div>
      {canEdit && <div className="actions" style={{ marginBottom: 10 }}><span className="spacer" /><button className="b p" id="room-book" onClick={() => go('Rooms', 'bookings', 'new')}>{t('room.newBooking')}</button></div>}
      {list(t('room.arrivalsToday'), x.arrivals, (b) => canEdit ? <button className="b small p" disabled={busy} id={`checkin-${b.room}`}
        onClick={() => void run(() => api(`/api/bookings/${b.id}/check-in`, { body: {} }), t('room.checkedIn'), d.reload)}>{t('room.checkIn')}</button> : null)}
      {list(t('room.departuresToday'), x.departures, (b) => <button className="b small" onClick={() => go('Rooms', 'bookings', b.id)}>{t('room.checkOut')}</button>)}
      {list(t('room.inHouse'), x.inHouse)}
      {x.notArrived.length > 0 && list(t('room.notArrived'), x.notArrived, (b) => canEdit ? <span className="actions" style={{ justifyContent: 'flex-end' }}>
        <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/bookings/${b.id}/check-in`, { body: {} }), t('room.checkedIn'), d.reload)}>{t('room.checkIn')}</button>
        <button className="b small" disabled={busy} onClick={() => void run(() => api(`/api/bookings/${b.id}/no-show`, { body: {} }), t('room.markedNoShow'), d.reload)}>{t('room.noShow')}</button></span> : null)}
    </>
  );
}

// ------------------------------------------------------------------ calendar
function CalendarPage({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t, lang } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [from, setFrom] = useState(today());
  const days = 14;
  const c = useApi<Cal>(`/api/companies/${books.company.id}/rooms/calendar?from=${from}&days=${days}`);
  if (c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('room.calHint')}</div>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => setFrom(addDays(from, -7))} aria-label={t('room.earlier')}>{t('room.earlier')}</button>
        <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label={t('room.from')} />
        <button className="b" onClick={() => setFrom(addDays(from, 7))} aria-label={t('room.later')}>{t('room.later')}</button>
        <span className="spacer" />
        {canEdit && <button className="b p" onClick={() => go('Rooms', 'bookings', 'new')}>{t('room.newBooking')}</button>}
      </div>
      {!c.data ? <Loading /> : c.data.rooms.length === 0 ? <div className="card mut">{t('room.noRooms')}</div> : (
        <div className="card">
          <div className="wrap room-cal-wrap">
            <table className="room-cal">
              <thead><tr><th>{t('room.room')}</th>{dates.map((d) => <th key={d} className={d === today() ? 'today' : ''}>{dayLabel(d)}</th>)}</tr></thead>
              <tbody>{c.data.rooms.map((r) => {
                const cells: ReactElement[] = [];
                for (let i = 0; i < dates.length;) {
                  const d = dates[i]!;
                  const b = c.data!.bookings.find((x) => x.roomId === r.id && x.arrival <= d && x.departure > d);
                  if (b) {
                    const span = Math.min(nightsOf(d, b.departure), dates.length - i);
                    cells.push(<td key={d} colSpan={span}><button className={`room-bar st-${b.status}`} onClick={() => go('Rooms', 'bookings', b.id)} title={`${b.number} · ${b.guest}`}>{b.guest}</button></td>);
                    i += span;
                  } else {
                    cells.push(<td key={d} className={r.status !== 'active' ? 'room-off' : ''}>{canEdit && r.status === 'active'
                      ? <button className="room-free" aria-label={t('room.bookOn', { room: r.number, date: d })} onClick={() => go('Rooms', 'bookings', 'new', `${r.id}_${d}`)}>+</button> : null}</td>);
                    i++;
                  }
                }
                return <tr key={r.id}><th scope="row"><b>{r.number}</b><div className="small mut">{local(r.typeName, r.typeNameAr)}</div></th>{cells}</tr>;
              })}</tbody>
            </table>
          </div>
          {/* On phones: the same as a list, room by room. */}
          <div className="room-cal-list">
            {c.data.rooms.map((r) => {
              const bs = c.data!.bookings.filter((x) => x.roomId === r.id);
              return (<div key={r.id} className="room-cal-item"><b>{r.number}</b> <span className="small mut">{local(r.typeName, r.typeNameAr)}</span>
                {r.status !== 'active' && <span className="badge"> {t(`room.rs.${r.status}` as Key)}</span>}
                {bs.length === 0 ? <div className="small mut">{t('room.freeAll')}</div> : bs.map((b) => (
                  <div key={b.id}><button className="link" onClick={() => go('Rooms', 'bookings', b.id)}>{b.guest}</button> <span className="small ltr">{b.arrival} → {b.departure}</span> <StatusBadge s={b.status} /></div>))}
              </div>);
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ bookings
function Bookings({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const [status, setStatus] = useState<'' | Status>('');
  const list = useApi<BookingRow[]>(`/api/companies/${books.company.id}/bookings${status ? `?status=${status}` : ''}`);
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <label className="f">{t('room.status')}<select value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
          <option value="">{t('room.all')}</option>{(['reserved', 'in_house', 'departed', 'cancelled', 'no_show'] as Status[]).map((s) => <option key={s} value={s}>{t(`room.st.${s}` as Key)}</option>)}</select></label>
        <span className="spacer" />
        {canEdit && <button className="b p" id="booking-new" onClick={() => go('Rooms', 'bookings', 'new')}>{t('room.newBooking')}</button>}
      </div>
      <div className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <div className="mut">{t('room.noBookings')}</div> : (
          <div className="wrap"><table className="stack">
            <thead><tr><th>{t('room.booking')}</th><th>{t('room.guest')}</th><th>{t('room.room')}</th><th>{t('room.dates')}</th><th>{t('room.status')}</th></tr></thead>
            <tbody>{list.data.map((b) => (
              <tr key={b.id}>
                <td><button className="link ltr" onClick={() => go('Rooms', 'bookings', b.id)}>{b.number}</button></td>
                <td data-label={t('room.guest')}>{local(b.guest, b.guestAr)}</td>
                <td data-label={t('room.room')}>{b.room} <span className="small mut">{local(b.typeName, b.typeNameAr)}</span></td>
                <td className="ltr small" data-label={t('room.dates')}>{b.arrival} → {b.departure} <span className="mut">({t('room.nightsN', { n: b.nights })})</span></td>
                <td data-label={t('room.status')}><StatusBadge s={b.status} /></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/** A quote for the stay as entered: nights at each rate, the bill total and any halala difference. */
function useQuote(books: CompanyBooks, types: RoomType[] | undefined, room: Room | undefined, arrival: string, departure: string, agreed: string) {
  return useMemo(() => {
    const type = types?.find((x) => x.id === room?.typeId);
    if (!type || !arrival || !departure || departure <= arrival) return null;
    const groups = groupNights(arrival, departure, type.rate, type.seasons, /^\d+(\.\d{1,2})?$/.test(agreed) ? Number(agreed).toFixed(2) : null);
    const lines = groups.map((g) => ({ ...g, ...nightsLine(g.nights, g.rate, books.company.vatRate) }));
    const sum = (k: 'total' | 'quoted') => lines.reduce((s, l) => s + Math.round(Number(l[k]) * 100), 0) / 100;
    return { lines, total: sum('total').toFixed(2), quoted: sum('quoted').toFixed(2), nights: nightsOf(arrival, departure) };
  }, [types, room, arrival, departure, agreed, books.company.vatRate]);
}

function NewBooking({ books }: { books: CompanyBooks }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const rooms = useApi<Room[]>(`/api/companies/${books.company.id}/rooms`);
  const types = useApi<RoomType[]>(`/api/companies/${books.company.id}/room-types`);
  const customers = useApi<Contact[]>(`/api/companies/${books.company.id}/contacts?role=customer`);
  const preset = (location.pathname.split('/').pop() ?? '').split('_');   // from the calendar: <roomId>_<date>
  const [f, setF] = useState({ contactId: '', name: '', phone: '', vatNumber: '', roomId: preset.length === 2 ? preset[0]! : '', arrival: preset.length === 2 ? preset[1]! : today(),
    departure: addDays(preset.length === 2 ? preset[1]! : today(), 1), adults: '1', children: '0', agreedRate: '', source: '', notes: '' });
  const { run, busy, note } = useRun();
  const room = rooms.data?.find((r) => r.id === f.roomId);
  const quote = useQuote(books, types.data, room, f.arrival, f.departure, f.agreedRate);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ id: string }>(`/api/companies/${books.company.id}/bookings`, { body: {
        contactId: f.contactId || null, guest: f.contactId ? null : { name: f.name, phone: f.phone, vatNumber: f.vatNumber },
        roomId: f.roomId, arrival: f.arrival, departure: f.departure, adults: f.adults, children: f.children, agreedRate: f.agreedRate || null, source: f.source, notes: f.notes } });
      go('Rooms', 'bookings', r.id);
    });
  };
  if (rooms.error) return <ErrorNote error={rooms.error} onRetry={rooms.reload} />;
  return (
    <form className="card" onSubmit={save}>
      <h2>{t('room.newBooking')}</h2>
      {note}
      <div className="row">
        <label className="f">{t('room.guest')}<select id="bk-contact" value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
          <option value="">{t('room.newGuest')}</option>{(customers.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{local(c.name, c.nameAr)}</option>)}</select></label>
        {!f.contactId && <>
          <label className="f">{t('room.guestName')}<input id="bk-name" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="f">{t('room.phone')}<input dir="ltr" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </>}
      </div>
      {!f.contactId && <div className="row"><label className="f">{t('room.guestVat')}<input dir="ltr" inputMode="numeric" value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
        <small className="mut">{t('room.guestVatHint')}</small></label></div>}
      <div className="row">
        <label className="f">{t('room.room')}<select id="bk-room" value={f.roomId} onChange={(e) => set('roomId', e.target.value)}>
          <option value="">{t('room.pickRoom')}</option>
          {(rooms.data ?? []).filter((r) => r.status === 'active').map((r) => <option key={r.id} value={r.id}>{r.number} · {local(r.typeName, r.typeNameAr)} · {fmt(r.rate)}</option>)}</select></label>
        <label className="f">{t('room.arrival')}<input id="bk-arrival" type="date" value={f.arrival} onChange={(e) => setF({ ...f, arrival: e.target.value, departure: f.departure > e.target.value ? f.departure : addDays(e.target.value, 1) })} /></label>
        <label className="f">{t('room.departure')}<input id="bk-departure" type="date" value={f.departure} min={addDays(f.arrival, 1)} onChange={(e) => set('departure', e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="f">{t('room.adults')}<input inputMode="numeric" value={f.adults} onChange={(e) => set('adults', e.target.value.replace(/\D/g, ''))} /></label>
        <label className="f">{t('room.children')}<input inputMode="numeric" value={f.children} onChange={(e) => set('children', e.target.value.replace(/\D/g, ''))} /></label>
        <label className="f">{t('room.agreedRate')}<input inputMode="decimal" className="num" value={f.agreedRate} placeholder={room ? fmt(room.rate) : ''} onChange={(e) => set('agreedRate', e.target.value)} />
          <small className="mut">{t('room.agreedRateHint')}</small></label>
      </div>
      <div className="row">
        <label className="f">{t('room.source')}<input list="room-sources" value={f.source} onChange={(e) => set('source', e.target.value)} /></label>
        <datalist id="room-sources">{['walk_in', 'phone', 'email', 'website', 'agent'].map((s) => <option key={s} value={t(`room.src.${s}` as Key)} />)}</datalist>
        <label className="f">{t('room.notes')}<input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      {quote && (
        <div className="inset small" id="bk-quote">
          {quote.lines.map((l) => <div key={l.from}>{t('room.quoteLine', { n: l.nights, rate: fmt(l.rate) })}</div>)}
          <div><b>{t('room.quoteTotal', { n: quote.nights, total: fmt(quote.total), cur: books.company.currency })}</b>
            {quote.total !== quote.quoted && <span className="mut"> · {t('room.quoteDiff', { quoted: fmt(quote.quoted) })}</span>}</div>
        </div>
      )}
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="b p" id="bk-save" disabled={busy || !f.roomId || (!f.contactId && !f.name.trim())}>{t('room.book')}</button>
        <button type="button" className="b" onClick={() => go('Rooms', 'bookings')}>{t('cancel')}</button>
      </div>
    </form>
  );
}

function BookingPage({ books, id, canEdit }: { books: CompanyBooks; id: string; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const go = useGo(books.company.id);
  const d = useApi<Booking>(`/api/bookings/${id}`);
  const rooms = useApi<Room[]>(`/api/companies/${books.company.id}/rooms`);
  const { run, busy, note } = useRun();
  const [extra, setExtra] = useState<{ date: string; description: string; quantity: string; unitPrice: string }>();
  const [edit, setEdit] = useState<{ roomId: string; arrival: string; departure: string; adults: string; children: string }>();
  const [upTo, setUpTo] = useState(today());
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const b = d.data;
  const open = canEdit && (b.status === 'reserved' || b.status === 'in_house');
  const canSales = accessTo(books.access?.permissions, 'Sales') === 'edit';
  const post = (path: string, body: object, ok: string, after?: (r: { documentId?: string | null }) => void) =>
    void run(async () => { const r = await api<{ documentId?: string | null }>(path, { body }); d.reload(); after?.(r); }, ok);
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button className="b" onClick={() => go('Rooms', 'bookings')}>{t('room.back')}</button>
        <span className="spacer" />
        {open && b.status === 'reserved' && <button className="b p" id="bk-checkin" disabled={busy} onClick={() => post(`/api/bookings/${id}/check-in`, {}, t('room.checkedIn'))}>{t('room.checkIn')}</button>}
        {open && b.status === 'reserved' && b.bills.length === 0 && <button className="b" disabled={busy} onClick={() => post(`/api/bookings/${id}/cancel`, {}, t('room.cancelled'))}>{t('room.cancel')}</button>}
        {open && b.status === 'reserved' && b.arrival <= today() && <button className="b" disabled={busy} onClick={() => post(`/api/bookings/${id}/no-show`, {}, t('room.markedNoShow'))}>{t('room.noShow')}</button>}
        {open && b.status === 'in_house' && canSales && <button className="b p" id="bk-checkout" disabled={busy}
          onClick={() => post(`/api/bookings/${id}/check-out`, { issue: true }, t('room.checkedOut'), (r) => r.documentId && go('Sales', 'invoices', r.documentId))}>{t('room.checkOutBill')}</button>}
      </div>
      {note}
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }} className="ltr">{b.number}</h2><StatusBadge s={b.status} /><span className="spacer" />
          {open && !edit && <button className="b small" onClick={() => setEdit({ roomId: b.roomId, arrival: b.arrival, departure: b.departure, adults: String(b.adults), children: String(b.children) })}>{t('room.change')}</button>}</div>
        <div><b>{local(b.guest, b.guestAr)}</b>{b.phone && <span className="small mut ltr"> · {b.phone}</span>}{b.guestVat && <span className="small mut ltr"> · {t('room.vatNo', { n: b.guestVat })}</span>}</div>
        <div className="small">{t('room.roomN', { n: b.room })} · {local(b.typeName, b.typeNameAr)} · <span className="ltr">{b.arrival} → {b.departure}</span> · {t('room.nightsN', { n: b.nights })} · {t('room.guestsN', { n: b.adults + b.children })}</div>
        {b.agreedRate && <div className="small">{t('room.agreedRateN', { rate: fmt(b.agreedRate) })}</div>}
        {(b.source || b.notes) && <div className="small mut">{[b.source, b.notes].filter(Boolean).join(' · ')}</div>}
        {edit && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); post(`/api/bookings/${id}`, edit, t('room.saved'), () => setEdit(undefined)); }}>
            <div className="row">
              <label className="f">{t('room.room')}<select value={edit.roomId} onChange={(e) => setEdit({ ...edit, roomId: e.target.value })}>
                {(rooms.data ?? []).filter((r) => r.status === 'active' || r.id === b.roomId).map((r) => <option key={r.id} value={r.id}>{r.number} · {local(r.typeName, r.typeNameAr)}</option>)}</select></label>
              <label className="f">{t('room.arrival')}<input type="date" value={edit.arrival} disabled={!!b.billedTo} onChange={(e) => setEdit({ ...edit, arrival: e.target.value })} /></label>
              <label className="f">{t('room.departure')}<input type="date" value={edit.departure} onChange={(e) => setEdit({ ...edit, departure: e.target.value })} /></label>
            </div>
            <div className="row">
              <label className="f">{t('room.adults')}<input inputMode="numeric" value={edit.adults} onChange={(e) => setEdit({ ...edit, adults: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="f">{t('room.children')}<input inputMode="numeric" value={edit.children} onChange={(e) => setEdit({ ...edit, children: e.target.value.replace(/\D/g, '') })} /></label>
            </div>
            <div className="actions"><button className="b p" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setEdit(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
      </div>

      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('room.extras')}</h2><span className="spacer" />
          {open && !extra && <button className="b small" id="bk-extra" onClick={() => setExtra({ date: today(), description: '', quantity: '1', unitPrice: '' })}>{t('room.addExtra')}</button>}</div>
        {extra && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); post(`/api/bookings/${id}/extras`, extra, t('room.extraAdded'), () => setExtra(undefined)); }}>
            <div className="row">
              <label className="f">{t('room.extraWhat')}<input id="ex-desc" list="room-extras" value={extra.description} onChange={(e) => setExtra({ ...extra, description: e.target.value })} /></label>
              <datalist id="room-extras">{['laundry', 'minibar', 'breakfast', 'transfer', 'parking'].map((s) => <option key={s} value={t(`room.ex.${s}` as Key)} />)}</datalist>
              <label className="f">{t('room.quantity')}<input inputMode="decimal" className="num" value={extra.quantity} onChange={(e) => setExtra({ ...extra, quantity: e.target.value })} /></label>
              <label className="f">{t('room.priceWithVat')}<input id="ex-price" inputMode="decimal" className="num" value={extra.unitPrice} onChange={(e) => setExtra({ ...extra, unitPrice: e.target.value })} /></label>
              <label className="f">{t('room.date')}<input type="date" value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></label>
            </div>
            <div className="actions"><button className="b p" id="ex-save" disabled={busy || !extra.description.trim() || !extra.unitPrice}>{t('room.addExtra')}</button>
              <button type="button" className="b" onClick={() => setExtra(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        {b.extras.length === 0 ? <div className="mut small" style={{ marginTop: 6 }}>{t('room.noExtras')}</div> : (
          <table className="stack" style={{ marginTop: 6 }}><tbody>{b.extras.map((x) => (
            <tr key={x.id}><td className="ltr small">{x.date}</td><td>{x.description}</td><td className="num">{Number(x.quantity)} × {fmt(x.unitPrice)}</td>
              <td className="num">{x.billed ? <span className="small mut">{t('room.billed')}</span> : open ? <button className="b small" disabled={busy} onClick={() => post(`/api/booking-extras/${x.id}/delete`, {}, t('room.removed'))}>{t('room.remove')}</button> : null}</td></tr>))}</tbody></table>
        )}
      </div>

      {b.unbilled && (
        <div className="card">
          <h2>{t('room.billTitle')}</h2>
          {b.unbilled.lines.length === 0 ? <div className="mut">{t('room.allBilled')}</div> : (
            <>
              <table className="stack"><tbody>{b.unbilled.lines.map((l, i) => (
                <tr key={i}><td className="small">{l.description}</td><td className="num">{fmt(l.total)}</td></tr>))}</tbody></table>
              <div style={{ marginTop: 6 }}><b>{t('room.billTotal', { total: fmt(b.unbilled.total), cur: books.company.currency })}</b>
                {b.unbilled.difference !== '0.00' && <div className="small mut" id="bk-diff">{t('room.billDiff', { quoted: fmt(b.unbilled.quoted), diff: b.unbilled.difference })}</div>}</div>
              {open && canSales && (
                <div className="actions" style={{ marginTop: 8 }}>
                  <label className="f">{t('room.billNightsBefore')}<input type="date" value={upTo} onChange={(e) => setUpTo(e.target.value)} /></label>
                  <button className="b" id="bk-bill" disabled={busy} onClick={() => post(`/api/bookings/${id}/bill`, { upTo }, t('room.billMade'), (r) => r.documentId && go('Sales', 'invoices', r.documentId))}>{t('room.billPart')}</button>
                </div>
              )}
              <div className="small mut" style={{ marginTop: 6 }}>{t('room.billHint')}</div>
            </>
          )}
        </div>
      )}
      {b.bills.length > 0 && (
        <div className="card">
          <h2>{t('room.invoices')}</h2>
          <table className="stack"><tbody>{b.bills.map((x) => (
            <tr key={x.id}><td><button className="link" onClick={() => go('Sales', 'invoices', x.documentId)}>{x.number ?? t('doc.draftNo')}</button></td>
              <td className="ltr small">{x.nightsFrom} → {x.nightsTo}</td><td className="num">{fmt(x.total)}</td><td>{t(`state.${x.status}` as Key)}</td></tr>))}</tbody></table>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ setup
function Setup({ books, canEdit }: { books: CompanyBooks; canEdit: boolean }) {
  const { t } = useI18n();
  const local = useLocalName();
  const types = useApi<RoomType[]>(`/api/companies/${books.company.id}/room-types`);
  const rooms = useApi<Room[]>(`/api/companies/${books.company.id}/rooms`);
  const { run, busy, note } = useRun();
  const [tf, setTf] = useState<{ id?: string; code: string; name: string; nameAr: string; capacity: string; rate: string; status: 'active' | 'retired' }>();
  const [rf, setRf] = useState<{ id?: string; number: string; typeId: string; floor: string; status: Room['status'] }>();
  const [sf, setSf] = useState<{ typeId: string; name: string; from: string; to: string; rate: string }>();
  if (types.error) return <ErrorNote error={types.error} onRetry={types.reload} />;
  if (!types.data || !rooms.data) return <Loading />;
  const reload = () => { types.reload(); rooms.reload(); };
  const saveType = (e: FormEvent) => { e.preventDefault(); const { id, ...body } = tf!;
    void run(() => api(id ? `/api/room-types/${id}` : `/api/companies/${books.company.id}/room-types`, { body }), t('room.saved'), () => { setTf(undefined); reload(); }); };
  const saveRoom = (e: FormEvent) => { e.preventDefault(); const { id, ...body } = rf!;
    void run(() => api(id ? `/api/rooms/${id}` : `/api/companies/${books.company.id}/rooms`, { body }), t('room.saved'), () => { setRf(undefined); reload(); }); };
  return (
    <>
      <div className="mut small" style={{ marginBottom: 10 }}>{t('room.setupHint')}</div>
      {note}
      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('room.types')}</h2><span className="spacer" />
          {canEdit && !tf && <button className="b small p" id="rt-new" onClick={() => setTf({ code: '', name: '', nameAr: '', capacity: '2', rate: '', status: 'active' })}>{t('room.newType')}</button>}</div>
        {tf && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={saveType}>
            <div className="row">
              <label className="f">{t('room.code')}<input id="rt-code" dir="ltr" value={tf.code} onChange={(e) => setTf({ ...tf, code: e.target.value })} /></label>
              <label className="f">{t('room.typeName')}<input id="rt-name" value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} /></label>
              <label className="f">{t('room.typeNameAr')}<input dir="rtl" value={tf.nameAr} onChange={(e) => setTf({ ...tf, nameAr: e.target.value })} /></label>
            </div>
            <div className="row">
              <label className="f">{t('room.capacity')}<input inputMode="numeric" value={tf.capacity} onChange={(e) => setTf({ ...tf, capacity: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="f">{t('room.rateWithVat')}<input id="rt-rate" inputMode="decimal" className="num" value={tf.rate} onChange={(e) => setTf({ ...tf, rate: e.target.value })} /></label>
              {tf.id && <label className="f">{t('room.status')}<select value={tf.status} onChange={(e) => setTf({ ...tf, status: e.target.value as 'active' | 'retired' })}>
                <option value="active">{t('room.rs.active')}</option><option value="retired">{t('room.rs.retired')}</option></select></label>}
            </div>
            <div className="actions"><button className="b p" id="rt-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setTf(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        {types.data.length === 0 ? <div className="mut" style={{ marginTop: 6 }}>{t('room.noTypes')}</div> : (
          <div className="wrap"><table className="stack" style={{ marginTop: 6 }}>
            <thead><tr><th>{t('room.type')}</th><th className="num">{t('room.rateWithVat')}</th><th>{t('room.capacity')}</th><th>{t('room.seasons')}</th><th /></tr></thead>
            <tbody>{types.data.map((x) => (
              <tr key={x.id}>
                <td><b>{local(x.name, x.nameAr)}</b> <span className="small mut ltr">{x.code}</span>{x.status === 'retired' && <span className="badge"> {t('room.rs.retired')}</span>}
                  <div className="small mut">{t('room.roomsN', { n: x.rooms })}</div></td>
                <td className="num" data-label={t('room.rateWithVat')}>{fmt(x.rate)}</td>
                <td data-label={t('room.capacity')}>{x.capacity}</td>
                <td className="small" data-label={t('room.seasons')}>{x.seasons.length === 0 ? '—' : x.seasons.map((s) => (
                  <div key={s.id}><span className="ltr">{s.from} → {s.to}</span> {fmt(s.rate)}{s.name && <span className="mut"> · {s.name}</span>}
                    {canEdit && <button className="link small" style={{ marginInlineStart: 6 }} onClick={() => void run(() => api(`/api/room-rates/${s.id}/delete`, { body: {} }), t('room.removed'), reload)}>{t('room.remove')}</button>}</div>))}</td>
                <td className="num">{canEdit && <span className="actions" style={{ justifyContent: 'flex-end' }}>
                  <button className="b small" onClick={() => setSf({ typeId: x.id, name: '', from: today(), to: addDays(today(), 30), rate: '' })}>{t('room.addSeason')}</button>
                  <button className="b small" onClick={() => setTf({ id: x.id, code: x.code, name: x.name, nameAr: x.nameAr ?? '', capacity: String(x.capacity), rate: x.rate, status: x.status })}>{t('room.change')}</button></span>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {sf && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/companies/${books.company.id}/room-rates`, { body: sf }), t('room.saved'), () => { setSf(undefined); reload(); }); }}>
            <h3>{t('room.addSeasonFor', { type: local(types.data.find((x) => x.id === sf.typeId)?.name ?? '', types.data.find((x) => x.id === sf.typeId)?.nameAr) })}</h3>
            <div className="row">
              <label className="f">{t('room.seasonName')}<input value={sf.name} placeholder={t('room.seasonExample')} onChange={(e) => setSf({ ...sf, name: e.target.value })} /></label>
              <label className="f">{t('room.firstNight')}<input type="date" value={sf.from} onChange={(e) => setSf({ ...sf, from: e.target.value })} /></label>
              <label className="f">{t('room.lastNight')}<input type="date" value={sf.to} onChange={(e) => setSf({ ...sf, to: e.target.value })} /></label>
              <label className="f">{t('room.rateWithVat')}<input inputMode="decimal" className="num" value={sf.rate} onChange={(e) => setSf({ ...sf, rate: e.target.value })} /></label>
            </div>
            <div className="actions"><button className="b p" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setSf(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
      </div>

      <div className="card">
        <div className="actions"><h2 style={{ margin: 0 }}>{t('room.rooms')}</h2><span className="spacer" />
          {canEdit && !rf && types.data.length > 0 && <button className="b small p" id="rm-new" onClick={() => setRf({ number: '', typeId: types.data![0]!.id, floor: '', status: 'active' })}>{t('room.newRoom')}</button>}</div>
        {rf && (
          <form className="inset" style={{ marginTop: 8 }} onSubmit={saveRoom}>
            <div className="row">
              <label className="f">{t('room.number')}<input id="rm-number" dir="ltr" value={rf.number} onChange={(e) => setRf({ ...rf, number: e.target.value })} /></label>
              <label className="f">{t('room.type')}<select id="rm-type" value={rf.typeId} onChange={(e) => setRf({ ...rf, typeId: e.target.value })}>
                {types.data.filter((x) => x.status === 'active' || x.id === rf.typeId).map((x) => <option key={x.id} value={x.id}>{local(x.name, x.nameAr)}</option>)}</select></label>
              <label className="f">{t('room.floor')}<input value={rf.floor} onChange={(e) => setRf({ ...rf, floor: e.target.value })} /></label>
              {rf.id && <label className="f">{t('room.status')}<select value={rf.status} onChange={(e) => setRf({ ...rf, status: e.target.value as Room['status'] })}>
                {(['active', 'out_of_service', 'retired'] as const).map((s) => <option key={s} value={s}>{t(`room.rs.${s}` as Key)}</option>)}</select></label>}
            </div>
            <div className="actions"><button className="b p" id="rm-save" disabled={busy}>{t('save')}</button><button type="button" className="b" onClick={() => setRf(undefined)}>{t('cancel')}</button></div>
          </form>
        )}
        {rooms.data.length === 0 ? <div className="mut" style={{ marginTop: 6 }}>{types.data.length ? t('room.noRooms') : t('room.typesFirst')}</div> : (
          <div className="wrap"><table className="stack" style={{ marginTop: 6 }}>
            <thead><tr><th>{t('room.number')}</th><th>{t('room.type')}</th><th>{t('room.floor')}</th><th>{t('room.status')}</th><th /></tr></thead>
            <tbody>{rooms.data.map((r) => (
              <tr key={r.id}>
                <td><b className="ltr">{r.number}</b></td>
                <td data-label={t('room.type')}>{local(r.typeName, r.typeNameAr)}</td>
                <td data-label={t('room.floor')}>{r.floor ?? '—'}</td>
                <td data-label={t('room.status')}><span className={`badge ${r.status === 'active' ? 'good' : r.status === 'out_of_service' ? 'warn' : ''}`}>{t(`room.rs.${r.status}` as Key)}</span></td>
                <td className="num">{canEdit && <button className="b small" onClick={() => setRf({ id: r.id, number: r.number, typeId: r.typeId, floor: r.floor ?? '', status: r.status })}>{t('room.change')}</button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
