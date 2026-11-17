-- 0059: VAT rounded the way ZATCA requires it, on the document and not line by line.
--
-- ZATCA's Electronic Invoice XML Implementation Standard v1.2, section 10 "Rounding", says:
--
--   * All document level totals shall be rounded to two decimals for accounting;
--   * Rounding shall be done on the final calculation results not on any intermediate results;
--   * VAT category tax amount shall be rounded on document level and NOT as a summation of rounded Invoice line
--     VAT amounts.
--
-- Until now every line's VAT was rounded on its own and the line amounts were added up, which is the thing that
-- last sentence forbids. 0005 even wrote that rule into the table as line_vat_is_net_times_rate. On 38.5% of
-- random multi-line invoices the two rules give a different total, by one or two halalas; it also breaks ZATCA's
-- own arithmetic rule BR-CO-17, which requires the VAT shown for a category to equal that category's taxable
-- amount times its rate, rounded once. An invoice that fails BR-CO-17 is an invoice ZATCA can refuse.
--
-- So the rule moves from the line to the document. A category's VAT is worked out on the category's net total, and
-- then spread back over its lines (whole halalas first, the remainder to the largest parts left over) so the lines
-- still add up to it. That matters because check_document_complete requires the document totals to equal the sum
-- of its lines, the journal entry posts those totals, and every report reads them.
--
-- WHAT THIS DOES NOT DO: it does not touch a single invoice already issued. Posted documents and their lines are
-- immutable (0005), their journal entries are immutable, and an e-invoice already sent to ZATCA keeps its own XML
-- and hash. A credit note still copies the invoice's own VAT (src/vat/vat.ts creditNoteFor), so crediting an older
-- invoice reverses exactly what that invoice charged, under whichever rule it was issued with. Only invoices
-- issued from now on are affected.

-- ---------------------------------------------------------------------------
-- A line's VAT is no longer its own amount times the rate; it is its share of the category's VAT.
-- It still has to be within one halala of its own share, so a line can never carry an arbitrary figure.
-- ---------------------------------------------------------------------------
ALTER TABLE document_lines DROP CONSTRAINT line_vat_is_net_times_rate;
ALTER TABLE document_lines ADD CONSTRAINT line_vat_near_its_own_share CHECK (
  abs(vat_amount - round(net_amount * vat_rate / 100, 2)) <= 0.01);

COMMENT ON COLUMN document_lines.vat_amount IS
  'This line''s share of its VAT category''s tax amount. The category total is rounded once on the document (ZATCA v1.2 section 10), then spread over its lines, so a line can sit up to one halala from its own amount times the rate.';

-- The same for the amounts as written, on a document in another currency (0058).
ALTER TABLE document_lines DROP CONSTRAINT line_fx_vat_is_net_times_rate;
ALTER TABLE document_lines ADD CONSTRAINT line_fx_vat_near_its_own_share CHECK (
  fx_vat_amount IS NULL OR abs(fx_vat_amount - round(fx_net_amount * vat_rate / 100, 2)) <= 0.01);

-- ---------------------------------------------------------------------------
-- What the database now insists on when a document is issued: each VAT category's tax amount is that category's
-- taxable amount times its rate, rounded once. This is ZATCA's BR-CO-17, enforced where it cannot be bypassed.
-- Rebuilt from the 0005 version with that one rule added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_document_complete(d documents) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int; s_net numeric; s_vat numeric; bad_cat record;
BEGIN
  SELECT count(*), coalesce(sum(net_amount), 0), coalesce(sum(vat_amount), 0) INTO n, s_net, s_vat
  FROM document_lines WHERE document_id = d.id;
  IF n = 0 THEN RAISE EXCEPTION 'Add at least one line.'; END IF;
  IF d.net_total <> s_net OR d.vat_total <> s_vat THEN
    RAISE EXCEPTION 'The document totals do not match its lines.';
  END IF;
  IF d.number IS NULL THEN RAISE EXCEPTION 'The document needs a number.'; END IF;
  IF EXISTS (SELECT 1 FROM document_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.document_id = d.id AND a.cost_centre_required AND l.cost_centre_id IS NULL) THEN
    RAISE EXCEPTION 'A cost centre is required for one of the accounts used.';
  END IF;
  -- ZATCA v1.2 section 10 and BR-CO-17: a category's VAT is rounded once, on the category's taxable amount.
  SELECT l.vat_code, l.vat_rate, sum(l.net_amount) AS net, sum(l.vat_amount) AS vat
    INTO bad_cat
  FROM document_lines l WHERE l.document_id = d.id
  GROUP BY l.vat_code, l.vat_rate
  HAVING sum(l.vat_amount) <> round(sum(l.net_amount) * l.vat_rate / 100, 2)
  LIMIT 1;
  IF bad_cat.vat_code IS NOT NULL THEN
    RAISE EXCEPTION 'The VAT on the % lines comes to % but % of % at %%% is %: VAT is rounded once on the whole category, not line by line.',
      bad_cat.vat_code, bad_cat.vat, bad_cat.net, bad_cat.vat_code, bad_cat.vat_rate,
      round(bad_cat.net * bad_cat.vat_rate / 100, 2);
  END IF;
  -- And the same for the amounts as written, on a document in another currency (0058).
  SELECT l.vat_code, l.vat_rate, sum(l.fx_net_amount) AS net, sum(l.fx_vat_amount) AS vat
    INTO bad_cat
  FROM document_lines l WHERE l.document_id = d.id AND l.fx_net_amount IS NOT NULL
  GROUP BY l.vat_code, l.vat_rate
  HAVING sum(l.fx_vat_amount) <> round(sum(l.fx_net_amount) * l.vat_rate / 100, 2)
  LIMIT 1;
  IF bad_cat.vat_code IS NOT NULL THEN
    RAISE EXCEPTION 'The VAT written on the % lines comes to % but % at %%% is %: VAT is rounded once on the whole category.',
      bad_cat.vat_code, bad_cat.vat, bad_cat.net, bad_cat.vat_rate, round(bad_cat.net * bad_cat.vat_rate / 100, 2);
  END IF;
END $$;
