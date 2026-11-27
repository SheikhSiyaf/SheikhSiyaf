// Rooms contract rules (src/books/roomContracts.ts): required fields per contract type, the Ejar warning, renewal alerts
// at 90 and 60 days, automatic renewal unless a notice was recorded 60 days before the end, the rent freeze, the
// maximum stay, extra charge lines and the payment schedule. Pure functions: no database.
import { describe, it, expect } from 'vitest';
import * as C from '../src/books/roomContracts.js';

const stay = { idType: 'iqama', idNumber: '2123456789', nationality: 'EG', checkIn: '2027-03-01', checkOut: '2027-03-04', guests: 2, verifiedBy: 'Huda', verifiedAt: '2027-03-01T10:00:00Z' };
const rental = { landlordName: 'A Co', landlordIdType: 'national_id', landlordIdNumber: '1000000001', tenantName: 'B', tenantIdType: 'iqama', tenantIdNumber: '2000000002',
  property: 'Tower 1', unit: '12B', city: 'Jeddah', startDate: '2027-01-01', endDate: '2028-01-01', rent: '36000.00', rentPeriod: 'yearly', deposit: '3000.00', vatCode: 'exempt',
  ejarStatus: 'registered', ejarNumber: '10234567' };

describe('Required fields', () => {
  it('a complete short stay passes; each missing detail is named', () => {
    expect(C.missingShortStay(stay)).toEqual([]);
    expect(C.missingShortStay({ ...stay, idNumber: ' ', nationality: null, verifiedBy: '' })).toEqual(['idNumber', 'nationality', 'verifiedBy']);
    expect(C.missingShortStay({ ...stay, idType: 'driving_licence' })).toEqual(['idType']);
    expect(C.missingShortStay({ ...stay, guests: 0 })).toEqual(['guests']);
    expect(C.missingShortStay({})).toHaveLength(8);
  });
  it('the four ID types are national ID, iqama, passport and the Ministry of Interior digital ID', () => {
    expect(C.ID_TYPES).toEqual(['national_id', 'iqama', 'passport', 'moi_digital']);
  });
  it('a complete long-term rental passes; a registered contract needs its Ejar number', () => {
    expect(C.missingLongTerm(rental)).toEqual([]);
    expect(C.missingLongTerm({ ...rental, ejarNumber: '' })).toEqual(['ejarNumber']);
    expect(C.missingLongTerm({ ...rental, ejarStatus: 'pending', ejarNumber: '' })).toEqual([]);
    expect(C.missingLongTerm({ ...rental, endDate: '2027-01-01' })).toEqual(['endDate']);
    expect(C.missingLongTerm({ ...rental, rent: '0' })).toEqual(['rent']);
    expect(C.missingLongTerm({ ...rental, vatCode: undefined })).toEqual(['vatCode']);
    expect(C.missingLongTerm({ ...rental, landlordName: '', tenantIdNumber: null })).toEqual(['landlordName', 'tenantIdNumber']);
  });
});

describe('Ejar warning', () => {
  it('shows unless the contract is registered', () => {
    expect(C.ejarWarning('not_registered')).toBe('Rental contracts must be registered in Ejar.');
    expect(C.ejarWarning('pending')).toBe('Rental contracts must be registered in Ejar.');
    expect(C.ejarWarning('registered')).toBeNull();
  });
});

describe('Renewal', () => {
  it('alerts at 90 days, then 60 days before the end; none before, none after the end', () => {
    expect(C.renewalAlert('2027-09-01', '2028-01-01')).toBeNull();      // 122 days
    expect(C.renewalAlert('2027-10-03', '2028-01-01')).toBe(90);       // 90 days
    expect(C.renewalAlert('2027-11-01', '2028-01-01')).toBe(90);       // 61 days
    expect(C.renewalAlert('2027-11-02', '2028-01-01')).toBe(60);       // 60 days
    expect(C.renewalAlert('2027-12-31', '2028-01-01')).toBe(60);
    expect(C.renewalAlert('2028-01-02', '2028-01-01')).toBeNull();     // ended
  });
  it('renews automatically unless a notice was recorded at least 60 days before the end', () => {
    expect(C.renewsAutomatically('2028-01-01', null)).toBe(true);
    expect(C.renewsAutomatically('2028-01-01', { date: '2027-11-02', by: 'Landlord' })).toBe(false);   // exactly 60 days
    expect(C.renewsAutomatically('2028-01-01', { date: '2027-11-03', by: 'Landlord' })).toBe(true);    // 59 days: too late
    expect(C.renewsAutomatically('2028-01-01', { date: '2027-10-01', by: '' })).toBe(true);            // nobody named
  });
  it('a notice must name the date and who gave it, and not be late', () => {
    expect(C.noticeProblem('2028-01-01', { date: '2027-10-01', by: 'Tenant' })).toBeNull();
    expect(C.noticeProblem('2028-01-01', { date: '2027-12-01', by: 'Tenant' })).toBe('late');
    expect(C.noticeProblem('2028-01-01', { date: '2027-10-01', by: '' })).toBe('incomplete');
    expect(C.noticeProblem('2028-01-01', { by: 'Tenant' })).toBe('incomplete');
  });
});

describe('Rent freeze', () => {
  it('blocks a rent above the last registered rent in a frozen city and says why', () => {
    const why = C.rentIncreaseBlock({ city: 'Riyadh', frozenCities: C.DEFAULT_FROZEN_CITIES, lastRegisteredRent: '36000.00', newRent: '36000.01' });
    expect(why).toMatch(/blocked in Riyadh/);
    expect(why).toMatch(/36000\.00/);
  });
  it('allows the same or a lower rent, and any rent elsewhere', () => {
    expect(C.rentIncreaseBlock({ city: 'Riyadh', frozenCities: ['Riyadh'], lastRegisteredRent: '36000.00', newRent: '36000.00' })).toBeNull();
    expect(C.rentIncreaseBlock({ city: ' riyadh ', frozenCities: ['Riyadh'], lastRegisteredRent: '36000.00', newRent: '30000' })).toBeNull();
    expect(C.rentIncreaseBlock({ city: 'Jeddah', frozenCities: ['Riyadh'], lastRegisteredRent: '36000.00', newRent: '99999' })).toBeNull();
    expect(C.rentIncreaseBlock({ city: 'Riyadh', frozenCities: ['Riyadh'], lastRegisteredRent: null, newRent: '99999' })).toBeNull();
  });
  it('the city list is a setting: removing Riyadh lifts the block, adding a city blocks it', () => {
    expect(C.rentIncreaseBlock({ city: 'Riyadh', frozenCities: [], lastRegisteredRent: '1000', newRent: '2000' })).toBeNull();
    expect(C.rentIncreaseBlock({ city: 'Dammam', frozenCities: ['Dammam'], lastRegisteredRent: '1000', newRent: '2000' })).toMatch(/Dammam/);
    expect(C.isFrozen('RIYADH', ['riyadh'])).toBe(true);
    expect(C.isFrozen('', ['Riyadh'])).toBe(false);
  });
});

describe('Maximum stay', () => {
  it('is off by default, and blocks a longer stay when set', () => {
    expect(C.stayTooLong('2027-03-01', '2027-06-01', null)).toBe(false);
    expect(C.stayTooLong('2027-03-01', '2027-06-01', 0)).toBe(false);
    expect(C.stayTooLong('2027-03-01', '2027-03-31', 30)).toBe(false);   // 30 nights
    expect(C.stayTooLong('2027-03-01', '2027-04-01', 30)).toBe(true);    // 31 nights
  });
});

describe('Extra charge lines and the guest price', () => {
  it('a charge is a percent of the price before tax, exact to the halala', () => {
    expect(C.chargeAmount(10_000n, '2.5')).toBe(250n);        // 100.00 x 2.5% = 2.50
    expect(C.chargeAmount(333n, '2.5')).toBe(8n);             // 8.325 -> 8 (half up)
    expect(C.chargeAmount(10_000n, '0')).toBe(0n);
    expect(() => C.chargeAmount(1n, 'abc')).toThrow(/Not a valid rate/);
  });
  it('the guest sees the price before tax, the tax as its own line, then each active charge', () => {
    const p = C.guestPriceLines({ totalWithVat: '575.00', vatRate: '15', charges: [{ name: 'Tourism charge', ratePercent: '2.5' }] });
    expect(p.lines.map((l) => l.label)).toEqual(['Room price before tax', 'Tax (15%)', 'Tourism charge']);
    expect(p.lines.map((l) => l.amount)).toEqual(['500.00', '75.00', '12.50']);
    expect(p.total).toBe('587.50');
    expect(C.guestPriceLines({ totalWithVat: '575.00', vatRate: '15', charges: [] }).total).toBe('575.00');
  });
});

describe('Payment schedule', () => {
  it('monthly: one rent a month from the start, each on the start day (shorter months use their last day)', () => {
    const s = C.instalments('2027-01-31', '2027-05-01', '3000.00', 'monthly');
    expect(s.map((x) => x.due)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(s.every((x) => x.amount === '3000.00')).toBe(true);
  });
  it('yearly: one rent a year; a two-year contract has two', () => {
    expect(C.instalments('2027-01-01', '2028-01-01', '36000', 'yearly').map((x) => x.due)).toEqual(['2027-01-01']);
    expect(C.instalments('2027-01-01', '2029-01-01', '36000', 'yearly').map((x) => x.due)).toEqual(['2027-01-01', '2028-01-01']);
  });
});
