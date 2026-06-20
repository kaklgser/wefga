
-- ============================================================
-- SECURITY HARDENING MIGRATION
-- Fixes: mutable search_path, SECURITY DEFINER exposure,
--        overly-broad RLS policies, smtp_pass column exposure
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Fix generate_order_id — pin search_path
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_order_id()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN 'SW-' || nextval('public.order_id_sequence')::text;
END;
$$;

-- ──────────────────────────────────────────────────────────
-- 2. Fix handle_new_user — pin search_path, restrict EXECUTE
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  phone_val text;
BEGIN
  phone_val := COALESCE(
    REGEXP_REPLACE(NEW.phone, '^\+91', ''),
    NEW.raw_user_meta_data->>'phone',
    ''
  );

  INSERT INTO public.profiles (id, full_name, phone, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    phone_val,
    COALESCE(NEW.email, '')
  )
  ON CONFLICT (id) DO UPDATE SET
    phone = EXCLUDED.phone
  WHERE public.profiles.phone = '' OR public.profiles.phone IS NULL;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

-- ──────────────────────────────────────────────────────────
-- 3. Fix current_app_role — pin search_path, restrict to authenticated
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    'anonymous'
  );
$$;

REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. Fix is_admin — pin search_path, restrict to authenticated
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT public.current_app_role() = 'admin';
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. Fix is_staff — pin search_path, restrict to authenticated
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT public.current_app_role() IN ('admin', 'chef');
$$;

REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. Fix save_smtp_settings — drop + recreate with pinned search_path
--    (must drop first to change defaults)
-- ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.save_smtp_settings(text, integer, text, text, text, text);

CREATE FUNCTION public.save_smtp_settings(
  p_smtp_host text,
  p_smtp_port integer,
  p_smtp_user text,
  p_smtp_pass text,
  p_smtp_from_email text DEFAULT NULL,
  p_smtp_from_name text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result json;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF p_smtp_pass IS NOT NULL AND p_smtp_pass <> '' THEN
    UPDATE public.site_settings SET
      smtp_host = p_smtp_host,
      smtp_port = p_smtp_port,
      smtp_user = p_smtp_user,
      smtp_pass = p_smtp_pass,
      smtp_from_email = COALESCE(NULLIF(p_smtp_from_email, ''), p_smtp_user),
      smtp_from_name = COALESCE(NULLIF(p_smtp_from_name, ''), 'The Supreme Waffle'),
      updated_at = now()
    WHERE id = true;
  ELSE
    UPDATE public.site_settings SET
      smtp_host = p_smtp_host,
      smtp_port = p_smtp_port,
      smtp_user = p_smtp_user,
      smtp_from_email = COALESCE(NULLIF(p_smtp_from_email, ''), p_smtp_user),
      smtp_from_name = COALESCE(NULLIF(p_smtp_from_name, ''), 'The Supreme Waffle'),
      updated_at = now()
    WHERE id = true;
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.site_settings (
      id, smtp_host, smtp_port, smtp_user, smtp_pass,
      smtp_from_email, smtp_from_name, updated_at
    ) VALUES (
      true, p_smtp_host, p_smtp_port, p_smtp_user,
      COALESCE(p_smtp_pass, ''),
      COALESCE(NULLIF(p_smtp_from_email, ''), p_smtp_user),
      COALESCE(NULLIF(p_smtp_from_name, ''), 'The Supreme Waffle'),
      now()
    );
  END IF;

  SELECT json_build_object('success', true) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.save_smtp_settings(text, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_smtp_settings(text, integer, text, text, text, text) TO authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. Fix add_staff_order_item — pin search_path, revoke from anon
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_staff_order_item(
  p_order_id uuid,
  p_menu_item_id uuid,
  p_quantity integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order record;
  v_menu_item record;
  v_quantity integer;
  v_line_total numeric(10,2);
  v_next_subtotal numeric(10,2);
  v_next_total numeric(10,2);
  v_paid_amount numeric(10,2);
  v_next_payment_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('chef', 'admin')
  ) THEN
    RAISE EXCEPTION 'Staff access required';
  END IF;

  v_quantity := GREATEST(COALESCE(p_quantity, 1), 1);

  IF v_quantity > 99 THEN
    RAISE EXCEPTION 'Quantity is too high';
  END IF;

  SELECT id, subtotal, total, payment_status, paid_amount, status
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IN ('cancelled', 'expired', 'delivered') THEN
    RAISE EXCEPTION 'Items cannot be added to this order';
  END IF;

  SELECT id, name, price, is_available
  INTO v_menu_item
  FROM public.menu_items
  WHERE id = p_menu_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;

  IF NOT COALESCE(v_menu_item.is_available, false) THEN
    RAISE EXCEPTION '% is not currently available', v_menu_item.name;
  END IF;

  v_line_total := ROUND((COALESCE(v_menu_item.price, 0) * v_quantity)::numeric, 2);
  v_next_subtotal := ROUND((COALESCE(v_order.subtotal, 0) + v_line_total)::numeric, 2);
  v_next_total := ROUND((COALESCE(v_order.total, 0) + v_line_total)::numeric, 2);
  v_paid_amount := CASE
    WHEN v_order.payment_status = 'paid'
      THEN GREATEST(COALESCE(v_order.paid_amount, v_order.total, 0), COALESCE(v_order.total, 0))
    ELSE COALESCE(v_order.paid_amount, 0)
  END;
  v_next_payment_status := CASE
    WHEN v_order.payment_status = 'paid' AND v_line_total > 0 THEN 'pending'
    ELSE v_order.payment_status
  END;

  INSERT INTO public.order_items (
    order_id,
    menu_item_id,
    item_name,
    quantity,
    unit_price,
    customizations
  )
  VALUES (
    p_order_id,
    p_menu_item_id,
    v_menu_item.name,
    v_quantity,
    v_menu_item.price,
    '[]'::jsonb
  );

  UPDATE public.orders
  SET
    subtotal = v_next_subtotal,
    total = v_next_total,
    payment_status = v_next_payment_status,
    payment_verified_at = CASE
      WHEN v_next_payment_status = 'pending' THEN NULL
      ELSE payment_verified_at
    END,
    paid_amount = v_paid_amount
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'lineTotal', v_line_total,
    'newTotal', v_next_total,
    'paymentStatus', v_next_payment_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_staff_order_item(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_staff_order_item(uuid, uuid, integer) TO authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. Fix website_is_open — SECURITY INVOKER, pin search_path
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.website_is_open()
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT site_is_open FROM public.site_settings WHERE id = true),
    true
  );
$$;

GRANT EXECUTE ON FUNCTION public.website_is_open() TO anon, authenticated;

-- ──────────────────────────────────────────────────────────
-- 9. Revoke smtp_pass (and mappls_rest_key) column access from
--    anon + authenticated BEFORE adding broader RLS SELECT policies
-- ──────────────────────────────────────────────────────────
REVOKE SELECT (smtp_pass), INSERT (smtp_pass), UPDATE (smtp_pass), REFERENCES (smtp_pass)
  ON public.site_settings FROM anon;

REVOKE SELECT (smtp_pass), INSERT (smtp_pass), UPDATE (smtp_pass), REFERENCES (smtp_pass)
  ON public.site_settings FROM authenticated;

REVOKE SELECT (mappls_rest_key), INSERT (mappls_rest_key), UPDATE (mappls_rest_key), REFERENCES (mappls_rest_key)
  ON public.site_settings FROM anon;

-- ──────────────────────────────────────────────────────────
-- 10. Fix site_settings RLS policies
-- ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Only admins can read site_settings" ON public.site_settings;

-- Anon can read the row (column grants restrict what they actually see)
CREATE POLICY "anon_read_public_site_settings" ON public.site_settings
  FOR SELECT TO anon
  USING (id = true);

-- Authenticated users can read site settings (column grants block smtp_pass)
CREATE POLICY "authenticated_read_site_settings" ON public.site_settings
  FOR SELECT TO authenticated
  USING (true);

-- ──────────────────────────────────────────────────────────
-- 11. Fix site_settings_public view — SECURITY INVOKER
-- ──────────────────────────────────────────────────────────
ALTER VIEW public.site_settings_public SET (security_invoker = true);

-- ──────────────────────────────────────────────────────────
-- 12. Rewrite orders INSERT policy — inline checks instead of
--     calling is_staff() / website_is_open() from anon context
-- ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Customers can place own orders" ON public.orders;

CREATE POLICY "Customers can place own orders" ON public.orders
  FOR INSERT
  WITH CHECK (
    -- Site open + (guest order OR own authenticated order)
    (
      COALESCE(
        (SELECT site_is_open FROM public.site_settings WHERE id = true),
        true
      )
      AND (
        (auth.uid() IS NULL AND user_id IS NULL)
        OR (auth.uid() = user_id)
      )
    )
    OR
    -- Staff can always place orders regardless of site_is_open
    (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
          AND role IN ('admin', 'chef', 'delivery')
      )
    )
  );

-- ──────────────────────────────────────────────────────────
-- 13. Fix contact_messages INSERT — replace WITH CHECK (true)
-- ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can submit contact messages" ON public.contact_messages;

CREATE POLICY "Anyone can submit contact messages" ON public.contact_messages
  FOR INSERT
  WITH CHECK (
    name IS NOT NULL
    AND length(trim(name)) BETWEEN 1 AND 200
    AND email IS NOT NULL
    AND email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
    AND message IS NOT NULL
    AND length(trim(message)) BETWEEN 1 AND 5000
  );
