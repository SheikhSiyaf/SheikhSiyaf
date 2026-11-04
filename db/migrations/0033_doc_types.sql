-- 0033 New document types (in a migration of their own: a new enum value can only be used once committed).
-- debit_note: a customer debit note raising what an issued invoice charged (ZATCA type 383).
-- purchase_order: an order to a supplier before the bill; no posting.
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'debit_note';
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'purchase_order';
