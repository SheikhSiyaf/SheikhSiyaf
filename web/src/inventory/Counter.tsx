// The counter layout for POS users (a client role with "counter only" on): a store keeper or cashier signs in and
// lands on their counter, with no books menu. Which counters they get follows the role's modules:
// the warehouse desk (Inventory or Restaurant materials) and, in a restaurant, the order pad.
import { useState } from 'react';
import type { CompanyBooks, Me } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { TopControls } from '../ui.tsx';
import { accessTo } from '../../../src/books/modules.ts';
import { FoodSale } from '../restaurant/Restaurant.tsx';
import { WarehouseDesk } from './Warehouse.tsx';
import { Icon } from '../icons.tsx';

type Tab = 'desk' | 'orders';

export function Counter({ me, books, onSignOut }: { me: Me; books: CompanyBooks; path: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const local = useLocalName();
  const mods = books.company.modules ?? [];
  const perms = books.access?.permissions;
  const stockMod = mods.includes('Restaurant') ? 'Restaurant' as const : 'Inventory' as const;
  const tabs: Tab[] = [];
  if (accessTo(perms, stockMod) !== 'none' && (mods.includes(stockMod))) tabs.push('desk');
  if (mods.includes('Restaurant') && accessTo(perms, 'Restaurant') !== 'none') tabs.push('orders');
  const [tab, setTab] = useState<Tab | undefined>(tabs.includes('orders') ? 'orders' : tabs[0]);
  const canPost = (m: string) => books.canPost && accessTo(perms, m) === 'edit';
  return (
    <div className="counter">
      <header className="counter-top">
        <div className="counter-who">
          <b>{local(books.company.name, books.company.nameAr ?? null)}</b>
          <span className="small mut">{me.user.name} · {local(books.access!.name, books.access!.nameAr ?? null)}</span>
        </div>
        {tabs.length > 1 && (
          <div className="chips" role="tablist" aria-label={t('wh.counters')}>
            {tabs.map((x) => (
              <button key={x} role="tab" id={`counter-${x}`} aria-selected={tab === x} className={`b ${tab === x ? 'p' : ''}`} onClick={() => setTab(x)}>
                <Icon name={x === 'orders' ? 'Restaurant' : 'Inventory'} size={16} /> {t(`wh.tab.${x}` as never)}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <TopControls>
          <button className="b" id="counter-signout" onClick={onSignOut}>{t('signOut')}</button>
        </TopControls>
      </header>
      <main className="counter-main">
        {!tab ? (
          <div className="card"><h2>{t('wh.noCounter')}</h2><p className="mut">{t('wh.noCounterText')}</p></div>
        ) : tab === 'orders' ? (
          <FoodSale books={{ ...books, canPost: canPost('Restaurant') }} counter />
        ) : (
          <WarehouseDesk key={stockMod} books={{ ...books, canPost: canPost(stockMod) }} mod={stockMod} />
        )}
      </main>
    </div>
  );
}
