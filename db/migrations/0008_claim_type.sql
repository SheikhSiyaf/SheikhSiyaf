-- 0008: employee expense claims are documents too. On its own so 0009 can use the new value.
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'claim';
