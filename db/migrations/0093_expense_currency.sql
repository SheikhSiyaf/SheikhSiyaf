-- Expenses can be written in another currency (like bills, 0058). The ledger stays in the company's currency: the expense posts the amounts
-- converted at the rate typed on it, and keeps the amounts as written in the currency. A bank or cash account is always in the company's currency
-- (0029), so what leaves the bank is the converted amount. Employee claims stay in the company's currency.
-- Reversible: put the old list back in doc_fx_type (only possible while no expense is in another currency).
ALTER TABLE documents DROP CONSTRAINT doc_fx_type;
ALTER TABLE documents ADD CONSTRAINT doc_fx_type CHECK (
  currency IS NULL
  OR type IN ('quotation', 'invoice', 'credit_note', 'debit_note', 'bill', 'supplier_credit', 'purchase_order', 'expense'));
