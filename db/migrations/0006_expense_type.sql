-- 0006: a new document type for expenses paid straight away (receipts, card and cash spending).
-- On its own, because a new enum value can only be used after this transaction commits (0007 uses it).
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'expense';
