-- 0050 A kind of user for the built-in automatic sender (0051). Its own migration: a new enum value is usable only
-- after the transaction that adds it.
ALTER TYPE user_kind ADD VALUE IF NOT EXISTS 'system';
