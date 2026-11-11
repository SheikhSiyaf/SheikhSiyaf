// Small line icons for the menu (24px grid, drawn with the text colour so they follow light and dark mode).
const P: Record<string, string> = {
  Home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  Portal: 'M4 4h16v12H8l-4 4zM8 9h8M8 12h5',
  Calendar: 'M4 6h16v14H4zM4 10h16M9 3v5M15 3v5',
  Approvals: 'M9 12l2 2 4-4M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  Sales: 'M4 19h16M7 16V9M12 16V5M17 16v-4',
  Purchases: 'M5 6h15l-2 8H7zM5 6L4 3H2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  Expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  Bank: 'M3 9l9-5 9 5M5 10v7M10 10v7M14 10v7M19 10v7M3 20h18',
  Inventory: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  Restaurant: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 2-2 6 0 8v10',
  Assets: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6',
  Rentals: 'M4 20h16M6 20V6l6-2v16M12 8h6l2 4v8M6 10h6',
  Projects: 'M3 7h6l2 2h10v10H3z',
  HRM: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a2.5 2.5 0 1 0 0-5M21 19c0-2-1.5-3.5-3.5-4',
  CRM: 'M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z',
  Journal: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM9 8h6M9 12h6',
  Ledger: 'M4 5h16v14H4zM4 10h16M10 10v9',
  Reports: 'M5 20V10M12 20V4M19 20v-7',
  Review: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11l2 2 3-3',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const d = P[name];
  if (!d) return null;
  return <svg className="ico" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
