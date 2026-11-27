-- Customer side of manual bank-transfer payments: the screen needs to know whether payments are switched on (a single yes/no, nothing else).
-- Additive and reversible: REVOKE EXECUTE ON FUNCTION subpay.enabled() FROM nusuh_app.
GRANT EXECUTE ON FUNCTION subpay.enabled() TO nusuh_app;
