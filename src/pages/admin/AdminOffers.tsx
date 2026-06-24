import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import {
  getOfferBadgeLabel,
  getOfferDisplayDescription,
  getOfferMode,
  getOfferRewardLabel,
  getOfferRuleSummary,
  getOfferTriggerType,
  isOfferCartEligible,
} from '../../lib/offers';
import { supabase } from '../../lib/supabase';
import type {
  Category,
  MenuItem,
  Offer,
  OfferCtaTargetType,
  OfferDiscountType,
  OfferMode,
  OfferRewardItemSource,
  OfferTriggerType,
} from '../../types';

type OfferMenuItemOption = Pick<MenuItem, 'id' | 'name' | 'price' | 'is_available'>;
type OfferCategoryOption = Pick<Category, 'id' | 'name'>;
type OfferQualifyingScope = 'item' | 'category';

interface OfferForm {
  id?: string;
  title: string;
  description: string;
  code: string;
  display_badge: string;
  display_reward: string;
  background_image_url: string;
  cta_text: string;
  cta_target_type: OfferCtaTargetType;
  cta_target_category_id: string;
  cta_target_menu_item_id: string;
  is_cart_eligible: boolean;
  applies_to_delivery: boolean;
  applies_to_takeaway: boolean;
  applies_to_dine_in: boolean;
  show_on_offers_page: boolean;
  hide_text_overlay: boolean;
  offer_mode: OfferMode;
  trigger_type: OfferTriggerType;
  discount_type: OfferDiscountType;
  discount_value: string;
  min_order: string;
  required_item_quantity: string;
  qualifying_scope: OfferQualifyingScope;
  qualifying_category_id: string;
  qualifying_menu_item_id: string;
  reward_menu_item_id: string;
  reward_item_source: OfferRewardItemSource;
  reward_item_quantity: string;
  valid_from: string;
  valid_until: string;
  is_active: boolean;
}

const DISPLAY_SCHEMA_SQL = `ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS display_badge text,
  ADD COLUMN IF NOT EXISTS display_reward text,
  ADD COLUMN IF NOT EXISTS is_cart_eligible boolean NOT NULL DEFAULT true;

UPDATE offers
SET is_cart_eligible = true
WHERE is_cart_eligible IS NULL;

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS background_image_url text,
  ADD COLUMN IF NOT EXISTS cta_text text;`;

const RULES_SCHEMA_SQL = `ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS offer_mode text NOT NULL DEFAULT 'coupon',
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'min_order',
  ADD COLUMN IF NOT EXISTS required_item_quantity integer;`;

const FREE_ITEM_SCHEMA_SQL = `ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_discount_type_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_discount_type_check
  CHECK (discount_type IN ('percentage', 'flat', 'free_addons', 'free_item'));

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS qualifying_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qualifying_menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reward_menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reward_item_source text NOT NULL DEFAULT 'specific_item',
  ADD COLUMN IF NOT EXISTS reward_item_quantity integer NOT NULL DEFAULT 1;

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_reward_item_quantity_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_reward_item_quantity_check
  CHECK (reward_item_quantity >= 1);

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_reward_item_source_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_reward_item_source_check
  CHECK (reward_item_source IN ('specific_item', 'qualifying_item'));

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_free_item_reward_required_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_free_item_reward_required_check
  CHECK (
    discount_type <> 'free_item'
    OR reward_item_source = 'qualifying_item'
    OR reward_menu_item_id IS NOT NULL
  );

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_free_item_scope_required_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_free_item_scope_required_check
  CHECK (
    discount_type <> 'free_item'
    OR trigger_type <> 'item_quantity'
    OR qualifying_category_id IS NOT NULL
    OR qualifying_menu_item_id IS NOT NULL
  );

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_free_item_matching_source_requires_quantity_trigger_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_free_item_matching_source_requires_quantity_trigger_check
  CHECK (
    discount_type <> 'free_item'
    OR reward_item_source <> 'qualifying_item'
    OR trigger_type = 'item_quantity'
  );`;

const CTA_TARGET_SCHEMA_SQL = `ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS cta_target_type text,
  ADD COLUMN IF NOT EXISTS cta_target_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cta_target_menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL;

UPDATE offers
SET cta_target_type = 'menu'
WHERE cta_target_type IS NULL;

ALTER TABLE offers
  ALTER COLUMN cta_target_type SET DEFAULT 'menu';`;

const OFFER_IMAGE_BUCKET = 'offer-images';
const MAX_OFFER_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_OFFER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const OFFER_IMAGE_STORAGE_SQL = `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'offer-images',
  'offer-images',
  true,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public can view offer images'
  ) THEN
    CREATE POLICY "Public can view offer images"
      ON storage.objects FOR SELECT TO public
      USING (bucket_id = 'offer-images');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Admins can upload offer images'
  ) THEN
    CREATE POLICY "Admins can upload offer images"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'offer-images' AND public.is_admin());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Admins can update offer images'
  ) THEN
    CREATE POLICY "Admins can update offer images"
      ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'offer-images' AND public.is_admin())
      WITH CHECK (bucket_id = 'offer-images' AND public.is_admin());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Admins can delete offer images'
  ) THEN
    CREATE POLICY "Admins can delete offer images"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'offer-images' AND public.is_admin());
  END IF;
END $$;`;

function toDateTimeLocalValue(value: string) {
  const date = new Date(value);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
  return new Date(value).toISOString();
}

function normalizeImageUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/^http:\/\//i, 'https://') : null;
}

function sanitizeFileName(fileName: string) {
  const trimmed = fileName.trim().toLowerCase();
  const sanitized = trimmed.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return sanitized || 'offer-image';
}

function isMissingOfferImageStorage(error: { message?: string } | null) {
  return Boolean(
    error?.message
    && /(bucket.*not found|resource was not found|storage.*not found|row-level security|permission denied|Unauthorized)/i.test(error.message),
  );
}

function buildEmptyOffer(): OfferForm {
  const validFrom = new Date();
  const validUntil = new Date(validFrom.getTime() + 30 * 24 * 60 * 60 * 1000);

  return {
    title: '',
    description: '',
    code: '',
    display_badge: '',
    display_reward: '',
    background_image_url: '',
    cta_text: '',
    cta_target_type: 'menu',
    cta_target_category_id: '',
    cta_target_menu_item_id: '',
    is_cart_eligible: true,
    applies_to_delivery: true,
    applies_to_takeaway: true,
    applies_to_dine_in: true,
    show_on_offers_page: true,
    hide_text_overlay: false,
    offer_mode: 'coupon',
    trigger_type: 'min_order',
    discount_type: 'percentage',
    discount_value: '10',
    min_order: '200',
    required_item_quantity: '3',
    qualifying_scope: 'item',
    qualifying_category_id: '',
    qualifying_menu_item_id: '',
    reward_menu_item_id: '',
    reward_item_source: 'specific_item',
    reward_item_quantity: '1',
    valid_from: toDateTimeLocalValue(validFrom.toISOString()),
    valid_until: toDateTimeLocalValue(validUntil.toISOString()),
    is_active: true,
  };
}

function mapOfferToForm(offer: Offer): OfferForm {
  return {
    id: offer.id,
    title: offer.title || '',
    description: offer.description,
    code: offer.code || '',
    display_badge: offer.display_badge || '',
    display_reward: offer.display_reward || '',
    background_image_url: offer.background_image_url || '',
    cta_text: offer.cta_text || '',
    cta_target_type: offer.cta_target_type === 'category'
      ? 'category'
      : offer.cta_target_type === 'item'
        ? 'item'
        : 'menu',
    cta_target_category_id: offer.cta_target_category_id || '',
    cta_target_menu_item_id: offer.cta_target_menu_item_id || '',
    is_cart_eligible: offer.is_cart_eligible !== false,
    applies_to_delivery: offer.applies_to_delivery !== false,
    applies_to_takeaway: offer.applies_to_takeaway !== false,
    applies_to_dine_in: offer.applies_to_dine_in !== false,
    show_on_offers_page: offer.show_on_offers_page !== false,
    hide_text_overlay: offer.hide_text_overlay === true,
    offer_mode: getOfferMode(offer),
    trigger_type: getOfferTriggerType(offer),
    discount_type: offer.discount_type,
    discount_value: String(offer.discount_value),
    min_order: String(offer.min_order),
    required_item_quantity: String(offer.required_item_quantity || 3),
    qualifying_scope: offer.qualifying_category_id ? 'category' : 'item',
    qualifying_category_id: offer.qualifying_category_id || '',
    qualifying_menu_item_id: offer.qualifying_menu_item_id || '',
    reward_menu_item_id: offer.reward_menu_item_id || '',
    reward_item_source: offer.reward_item_source === 'qualifying_item' ? 'qualifying_item' : 'specific_item',
    reward_item_quantity: String(offer.reward_item_quantity || 1),
    valid_from: toDateTimeLocalValue(offer.valid_from),
    valid_until: toDateTimeLocalValue(offer.valid_until),
    is_active: offer.is_active,
  };
}

function buildPreviewOffer(offer: OfferForm): Offer {
  const isCartEligible = offer.is_cart_eligible;

  return {
    id: offer.id || 'preview-offer',
    title: offer.title?.trim() || null,
    description: offer.description,
    code: isCartEligible && offer.offer_mode === 'coupon' && offer.code.trim() ? offer.code.trim().toUpperCase() : null,
    display_badge: offer.display_badge.trim() || null,
    display_reward: offer.display_reward.trim() || null,
    background_image_url: offer.background_image_url.trim() || null,
    cta_text: offer.cta_text.trim() || null,
    cta_target_type: offer.cta_target_type,
    cta_target_category_id: offer.cta_target_type === 'category' ? offer.cta_target_category_id.trim() || null : null,
    cta_target_menu_item_id: offer.cta_target_type === 'item' ? offer.cta_target_menu_item_id.trim() || null : null,
    is_cart_eligible: isCartEligible,
    applies_to_delivery: offer.applies_to_delivery,
    applies_to_takeaway: offer.applies_to_takeaway,
    applies_to_dine_in: offer.applies_to_dine_in,
    show_on_offers_page: offer.show_on_offers_page,
    hide_text_overlay: offer.hide_text_overlay,
    offer_mode: isCartEligible ? offer.offer_mode : 'automatic',
    trigger_type: isCartEligible ? offer.trigger_type : 'min_order',
    discount_type: isCartEligible ? offer.discount_type : 'flat',
    discount_value: isCartEligible && !['free_addons', 'free_item'].includes(offer.discount_type)
      ? parseFloat(offer.discount_value) || 0
      : 0,
    min_order: isCartEligible ? parseFloat(offer.min_order) || 0 : 0,
    required_item_quantity: isCartEligible && offer.trigger_type === 'item_quantity'
      ? Math.max(1, parseInt(offer.required_item_quantity, 10) || 1)
      : null,
    qualifying_category_id: isCartEligible ? offer.qualifying_category_id.trim() || null : null,
    qualifying_menu_item_id: isCartEligible ? offer.qualifying_menu_item_id.trim() || null : null,
    reward_menu_item_id: isCartEligible && offer.reward_item_source !== 'qualifying_item'
      ? offer.reward_menu_item_id.trim() || null
      : null,
    reward_item_source: isCartEligible && offer.discount_type === 'free_item'
      ? offer.reward_item_source
      : 'specific_item',
    reward_item_quantity: isCartEligible ? Math.max(1, parseInt(offer.reward_item_quantity, 10) || 1) : 1,
    valid_from: toIsoDateTime(offer.valid_from),
    valid_until: toIsoDateTime(offer.valid_until),
    is_active: offer.is_active,
  };
}

function isMissingOfferRulesSchema(error: { message?: string } | null) {
  return Boolean(
    error?.message
    && /Could not find the '(offer_mode|trigger_type|required_item_quantity)' column of 'offers'/.test(error.message),
  );
}

function isMissingOfferDisplaySchema(error: { message?: string } | null) {
  return Boolean(
    error?.message
    && /Could not find the '(display_badge|display_reward|background_image_url|cta_text|is_cart_eligible)' column of 'offers'/.test(error.message),
  );
}

function isMissingOfferFreeItemSchema(error: { message?: string } | null) {
  return Boolean(
    error?.message
    && (
      /Could not find the '(qualifying_category_id|qualifying_menu_item_id|reward_menu_item_id|reward_item_source|reward_item_quantity)' column of 'offers'/.test(error.message)
      || /offers_discount_type_check|offers_reward_item_quantity_check|offers_reward_item_source_check|offers_free_item_reward_required_check|offers_free_item_scope_required_check|offers_free_item_matching_source_requires_quantity_trigger_check/.test(error.message)
    ),
  );
}

function isMissingOfferCtaTargetSchema(error: { message?: string } | null) {
  return Boolean(
    error?.message
    && /Could not find the '(cta_target_type|cta_target_category_id|cta_target_menu_item_id)' column of 'offers'/.test(error.message),
  );
}

function canUseLegacyOfferSchema(offer: OfferForm) {
  return offer.is_cart_eligible
    && offer.offer_mode === 'coupon'
    && offer.trigger_type === 'min_order'
    && !['free_addons', 'free_item'].includes(offer.discount_type);
}

function canUseLegacyOfferDisplaySchema(offer: OfferForm) {
  return offer.is_cart_eligible
    && !offer.display_badge.trim()
    && !offer.display_reward.trim()
    && !offer.background_image_url.trim()
    && !offer.cta_text.trim();
}

export default function AdminOffers() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [categories, setCategories] = useState<OfferCategoryOption[]>([]);
  const [menuItems, setMenuItems] = useState<OfferMenuItemOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OfferForm | null>(null);
  const [failedImageUrls, setFailedImageUrls] = useState<Record<string, true>>({});
  const [displaySchemaAvailable, setDisplaySchemaAvailable] = useState<boolean | null>(null);
  const [rulesSchemaAvailable, setRulesSchemaAvailable] = useState<boolean | null>(null);
  const [freeItemSchemaAvailable, setFreeItemSchemaAvailable] = useState<boolean | null>(null);
  const [ctaTargetSchemaAvailable, setCtaTargetSchemaAvailable] = useState<boolean | null>(null);
  const [deliveryOnlySchemaAvailable, setDeliveryOnlySchemaAvailable] = useState<boolean | null>(null);
  const [orderTypeSchemaAvailable, setOrderTypeSchemaAvailable] = useState<boolean | null>(null);
  const [offerImageUploadAvailable, setOfferImageUploadAvailable] = useState<boolean | null>(null);
  const [uploadingBackgroundImage, setUploadingBackgroundImage] = useState(false);
  const backgroundImageInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToast();
  const activeOffers = offers.filter((offer) => offer.is_active);
  const carouselOffers = activeOffers.slice(0, 4);
  const previewOffer = editing ? buildPreviewOffer(editing) : null;
  const previewDescription = previewOffer ? getOfferDisplayDescription(previewOffer) : null;
  const previewRewardLabel = previewOffer ? getOfferRewardLabel(previewOffer) : null;
  const markImageFailed = useCallback((url: string) => {
    setFailedImageUrls((current) => (current[url] ? current : { ...current, [url]: true }));
  }, []);

  const uploadOfferBackgroundImage = useCallback(async (file: File) => {
    if (!editing) {
      return;
    }

    if (displaySchemaAvailable === false) {
      showToast(
        'Run migrations 20260330120000 and 20260330123000 before saving background images, custom labels, or display-only promos.',
        'error',
      );
      return;
    }

    if (!ACCEPTED_OFFER_IMAGE_TYPES.includes(file.type)) {
      showToast('Use a PNG, JPG, WEBP, or GIF image', 'error');
      return;
    }

    if (file.size > MAX_OFFER_IMAGE_SIZE_BYTES) {
      showToast('Offer background images must be 5 MB or smaller', 'error');
      return;
    }

    setUploadingBackgroundImage(true);

    const filePath = `backgrounds/${editing.id || 'draft'}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
    const { error } = await supabase.storage.from(OFFER_IMAGE_BUCKET).upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    });

    if (error) {
      if (isMissingOfferImageStorage(error)) {
        setOfferImageUploadAvailable(false);
        showToast(
          'Offer image uploads are not ready. Run the offer-images storage migration in Supabase first.',
          'error',
        );
      } else {
        showToast(error.message || 'Failed to upload background image', 'error');
      }
      setUploadingBackgroundImage(false);
      return;
    }

    const { data } = supabase.storage.from(OFFER_IMAGE_BUCKET).getPublicUrl(filePath);
    const nextUrl = data.publicUrl;

    setEditing((current) => (current ? { ...current, background_image_url: nextUrl } : current));
    setOfferImageUploadAvailable(true);
    setFailedImageUrls((current) => {
      if (!current[nextUrl]) return current;
      const next = { ...current };
      delete next[nextUrl];
      return next;
    });
    setUploadingBackgroundImage(false);
    showToast('Background image uploaded');
  }, [displaySchemaAvailable, editing, showToast]);

  const handleBackgroundImageFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    void uploadOfferBackgroundImage(file);
  }, [uploadOfferBackgroundImage]);

  const loadOffers = useCallback(async () => {
    const [
      { data, error },
      { data: menuItemsData, error: menuItemsError },
      { data: categoriesData, error: categoriesError },
    ] = await Promise.all([
      supabase
        .from('offers')
        .select('*')
        .order('is_active', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('menu_items')
        .select('id, name, price, is_available')
        .order('display_order'),
      supabase
        .from('categories')
        .select('id, name')
        .order('display_order'),
    ]);

    if (error) {
      showToast(error.message || 'Failed to load offers', 'error');
    }

    if (menuItemsError) {
      showToast(menuItemsError.message || 'Failed to load menu items', 'error');
    }

    if (categoriesError) {
      showToast(categoriesError.message || 'Failed to load categories', 'error');
    }

    const loadedOffers = data || [];
    setMenuItems(menuItemsData || []);
    setCategories(categoriesData || []);
    setOffers(loadedOffers);

    if (loadedOffers.length > 0) {
      const sampleOffer = loadedOffers[0] as Record<string, unknown>;
      setDisplaySchemaAvailable(
        ['display_badge', 'display_reward', 'background_image_url', 'cta_text', 'is_cart_eligible']
          .every((column) => Object.prototype.hasOwnProperty.call(sampleOffer, column)),
      );
      setRulesSchemaAvailable(
        ['offer_mode', 'trigger_type', 'required_item_quantity']
          .every((column) => Object.prototype.hasOwnProperty.call(sampleOffer, column)),
      );
      setFreeItemSchemaAvailable(
        ['qualifying_category_id', 'qualifying_menu_item_id', 'reward_menu_item_id', 'reward_item_source', 'reward_item_quantity']
          .every((column) => Object.prototype.hasOwnProperty.call(sampleOffer, column)),
      );
      setCtaTargetSchemaAvailable(
        ['cta_target_type', 'cta_target_category_id', 'cta_target_menu_item_id']
          .every((column) => Object.prototype.hasOwnProperty.call(sampleOffer, column)),
      );
      setDeliveryOnlySchemaAvailable(
        Object.prototype.hasOwnProperty.call(sampleOffer, 'delivery_only'),
      );
      setOrderTypeSchemaAvailable(
        ['applies_to_delivery', 'applies_to_takeaway', 'applies_to_dine_in', 'show_on_offers_page', 'hide_text_overlay']
          .every((column) => Object.prototype.hasOwnProperty.call(sampleOffer, column)),
      );
    } else {
      setDisplaySchemaAvailable(null);
      setRulesSchemaAvailable(null);
      setFreeItemSchemaAvailable(null);
      setCtaTargetSchemaAvailable(null);
      setDeliveryOnlySchemaAvailable(null);
      setOrderTypeSchemaAvailable(null);
    }

    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    void loadOffers();
  }, [loadOffers]);

  async function saveOffer() {
    if (!editing) {
      return;
    }

    if (editing.is_cart_eligible && editing.offer_mode === 'coupon' && !editing.code.trim()) {
      showToast('Coupon code is required for coupon offers', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && editing.trigger_type === 'item_quantity'
      && (!Number.isFinite(Number(editing.required_item_quantity)) || Number(editing.required_item_quantity) < 1)
    ) {
      showToast('Item quantity trigger must be at least 1', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && editing.discount_type === 'free_item'
      && editing.reward_item_source === 'specific_item'
      && !editing.reward_menu_item_id
    ) {
      showToast('Select the free item that should be added automatically', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && editing.discount_type === 'free_item'
      && editing.reward_item_source === 'qualifying_item'
      && editing.trigger_type !== 'item_quantity'
    ) {
      showToast('Same-item rewards require the item quantity trigger', 'error');
      return;
    }

    if (editing.cta_target_type === 'category' && !editing.cta_target_category_id) {
      showToast('Select the category the banner button should open', 'error');
      return;
    }

    if (editing.cta_target_type === 'item' && !editing.cta_target_menu_item_id) {
      showToast('Select the product the banner button should open', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && editing.discount_type === 'free_item'
      && editing.trigger_type === 'item_quantity'
      && !editing.qualifying_menu_item_id
      && !editing.qualifying_category_id
    ) {
      showToast('Select the item or category customers must buy to unlock the free item', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && editing.discount_type === 'free_item'
      && (!Number.isFinite(Number(editing.reward_item_quantity)) || Number(editing.reward_item_quantity) < 1)
    ) {
      showToast('Free item quantity must be at least 1', 'error');
      return;
    }

    if (
      editing.is_cart_eligible
      && (!Number.isFinite(Number(editing.min_order)) || Number(editing.min_order) < 0)
    ) {
      showToast('Minimum order value cannot be negative', 'error');
      return;
    }

    const validFrom = toIsoDateTime(editing.valid_from);
    const validUntil = toIsoDateTime(editing.valid_until);
    if (new Date(validUntil) <= new Date(validFrom)) {
      showToast('Offer end time must be after the start time', 'error');
      return;
    }

    const resolvedOfferMode: OfferMode = editing.is_cart_eligible ? editing.offer_mode : 'automatic';
    const resolvedTriggerType: OfferTriggerType = editing.is_cart_eligible ? editing.trigger_type : 'min_order';
    const deliveryOnlyField = deliveryOnlySchemaAvailable !== false && !orderTypeSchemaAvailable
      ? { delivery_only: !editing.applies_to_takeaway && !editing.applies_to_dine_in && editing.applies_to_delivery }
      : {};
    const orderTypeField = orderTypeSchemaAvailable !== false
      ? {
          applies_to_delivery: editing.applies_to_delivery,
          applies_to_takeaway: editing.applies_to_takeaway,
          applies_to_dine_in: editing.applies_to_dine_in,
          show_on_offers_page: editing.show_on_offers_page,
          hide_text_overlay: editing.hide_text_overlay,
        }
      : {};

    const legacyPayload = {
      title: editing.title.trim() || null,
      description: editing.description.trim(),
      code: resolvedOfferMode === 'coupon' ? editing.code.trim().toUpperCase() : null,
      discount_type: editing.is_cart_eligible ? editing.discount_type : 'flat',
      discount_value: editing.is_cart_eligible && !['free_addons', 'free_item'].includes(editing.discount_type)
        ? parseFloat(editing.discount_value) || 0
        : 0,
      min_order: editing.is_cart_eligible ? Math.max(0, parseFloat(editing.min_order) || 0) : 0,
      valid_from: validFrom,
      valid_until: validUntil,
      is_active: editing.is_active,
      ...deliveryOnlyField,
      ...orderTypeField,
    };

    const rulesPayload = {
      ...legacyPayload,
      offer_mode: resolvedOfferMode,
      trigger_type: resolvedTriggerType,
      required_item_quantity: editing.is_cart_eligible && resolvedTriggerType === 'item_quantity'
        ? Math.max(1, parseInt(editing.required_item_quantity, 10) || 1)
        : null,
    };

    const displayPayload = {
      ...rulesPayload,
      display_badge: editing.display_badge.trim() || null,
      display_reward: editing.display_reward.trim() || null,
      background_image_url: editing.background_image_url.trim() || null,
      cta_text: editing.cta_text.trim() || null,
      is_cart_eligible: editing.is_cart_eligible,
    };

    const legacyDisplayPayload = {
      ...legacyPayload,
      display_badge: editing.display_badge.trim() || null,
      display_reward: editing.display_reward.trim() || null,
      background_image_url: editing.background_image_url.trim() || null,
      cta_text: editing.cta_text.trim() || null,
      is_cart_eligible: editing.is_cart_eligible,
    };

    const freeItemPayload = {
      ...displayPayload,
      qualifying_category_id: editing.is_cart_eligible && resolvedTriggerType === 'item_quantity'
        ? editing.qualifying_category_id || null
        : null,
      qualifying_menu_item_id: editing.is_cart_eligible && resolvedTriggerType === 'item_quantity'
        ? editing.qualifying_menu_item_id || null
        : null,
      reward_menu_item_id: editing.is_cart_eligible && editing.discount_type === 'free_item' && editing.reward_item_source === 'specific_item'
        ? editing.reward_menu_item_id || null
        : null,
      reward_item_source: editing.is_cart_eligible && editing.discount_type === 'free_item'
        ? editing.reward_item_source
        : 'specific_item',
      reward_item_quantity: editing.is_cart_eligible && editing.discount_type === 'free_item'
        ? Math.max(1, parseInt(editing.reward_item_quantity, 10) || 1)
        : 1,
    };

    const ctaTargetPayload = {
      ...displayPayload,
      cta_target_type: editing.cta_target_type,
      cta_target_category_id: editing.cta_target_type === 'category'
        ? editing.cta_target_category_id || null
        : null,
      cta_target_menu_item_id: editing.cta_target_type === 'item'
        ? editing.cta_target_menu_item_id || null
        : null,
    };

    const fullExtendedPayload = {
      ...freeItemPayload,
      cta_target_type: editing.cta_target_type,
      cta_target_category_id: editing.cta_target_type === 'category'
        ? editing.cta_target_category_id || null
        : null,
      cta_target_menu_item_id: editing.cta_target_type === 'item'
        ? editing.cta_target_menu_item_id || null
        : null,
    };

    const savePayload = (
      payload:
      | typeof legacyPayload
      | typeof rulesPayload
      | typeof displayPayload
      | typeof legacyDisplayPayload
      | typeof freeItemPayload
      | typeof ctaTargetPayload
      | typeof fullExtendedPayload,
    ) => (
      editing.id
        ? supabase.from('offers').update(payload).eq('id', editing.id)
        : supabase.from('offers').insert(payload)
    );

    let usedLegacyDisplayFallback = false;
    let usedLegacyRulesFallback = false;
    const requiresFreeItemSchema = Boolean(
      editing.is_cart_eligible
      && (
        editing.discount_type === 'free_item'
        || editing.qualifying_category_id
        || editing.qualifying_menu_item_id
        || editing.reward_menu_item_id
        || editing.reward_item_source !== 'specific_item'
        || parseInt(editing.reward_item_quantity, 10) > 1
      )
    );
    const requiresDisplaySchema = Boolean(
      !editing.is_cart_eligible
      || editing.display_badge.trim()
      || editing.display_reward.trim()
      || editing.background_image_url.trim()
      || editing.cta_text.trim()
    );
    const requiresCtaTargetSchema = editing.cta_target_type !== 'menu';
    const requiresRulesSchema = !canUseLegacyOfferSchema(editing);
    const droppedDisplayFields = Boolean(
      editing.display_badge.trim()
      || editing.display_reward.trim()
      || editing.background_image_url.trim()
      || editing.cta_text.trim()
    );

    if (requiresDisplaySchema && displaySchemaAvailable === false) {
      showToast(
        'Run migrations 20260330120000, 20260330123000, and 20260331140000 before saving background images, CTA text, custom labels, or display-only promos.',
        'error',
      );
      return;
    }

    if (requiresFreeItemSchema && freeItemSchemaAvailable === false) {
      showToast(
        'Run Supabase free-item migrations through 20260408120000_add_offer_reward_item_source.sql before using free-item promotions.',
        'error',
      );
      return;
    }

    if (requiresCtaTargetSchema && ctaTargetSchemaAvailable === false) {
      showToast(
        'Run Supabase migration 20260401131500_add_offer_cta_targets.sql before linking banner buttons to categories or products.',
        'error',
      );
      return;
    }

    if (requiresRulesSchema && rulesSchemaAvailable === false) {
      showToast(
        'Run Supabase migration 20260321143000_extend_offers_for_rule_based_promotions.sql before using automatic, quantity, free add-on, or free-item offers',
        'error',
      );
      return;
    }

    const initialPayload = requiresFreeItemSchema
      ? (requiresCtaTargetSchema ? fullExtendedPayload : freeItemPayload)
      : (requiresCtaTargetSchema ? ctaTargetPayload : displayPayload);

    let { error } = await savePayload(initialPayload);

    if (error && isMissingOfferFreeItemSchema(error)) {
      setFreeItemSchemaAvailable(false);
      showToast(
        'Run Supabase free-item migrations through 20260408120000_add_offer_reward_item_source.sql before using free-item promotions.',
        'error',
      );
      return;
    }

    if (error && isMissingOfferCtaTargetSchema(error)) {
      setCtaTargetSchemaAvailable(false);
      showToast(
        'Run Supabase migration 20260401131500_add_offer_cta_targets.sql before linking banner buttons to categories or products.',
        'error',
      );
      return;
    }

    if (error && isMissingOfferDisplaySchema(error)) {
      setDisplaySchemaAvailable(false);
      if (requiresDisplaySchema || !canUseLegacyOfferDisplaySchema(editing)) {
        showToast(
          'Run migrations 20260330120000, 20260330123000, and 20260331140000 before saving background images, CTA text, custom labels, or display-only promos.',
          'error',
        );
        return;
      }

      usedLegacyDisplayFallback = true;
      ({ error } = await savePayload(rulesPayload));
    }

    if (error && isMissingOfferRulesSchema(error)) {
      setRulesSchemaAvailable(false);
      if (!canUseLegacyOfferSchema(editing)) {
        showToast(
          'Run Supabase migration 20260321143000_extend_offers_for_rule_based_promotions.sql before using automatic, quantity, free add-on, or free-item offers',
          'error',
        );
        return;
      }

      usedLegacyRulesFallback = true;
      ({ error } = await savePayload(
        displaySchemaAvailable === false || usedLegacyDisplayFallback
          ? legacyPayload
          : legacyDisplayPayload,
      ));

      if (error && isMissingOfferDisplaySchema(error)) {
        setDisplaySchemaAvailable(false);
        if (requiresDisplaySchema || !canUseLegacyOfferDisplaySchema(editing)) {
          showToast(
            'Run migrations 20260330120000, 20260330123000, and 20260331140000 before saving background images, CTA text, custom labels, or display-only promos.',
            'error',
          );
          return;
        }

        usedLegacyDisplayFallback = true;
        ({ error } = await savePayload(legacyPayload));
      }
    }

    if (error) {
      showToast(error.message || 'Failed to save offer', 'error');
      return;
    }

    if (!usedLegacyDisplayFallback) {
      setDisplaySchemaAvailable(true);
    }

    if (!usedLegacyRulesFallback) {
      setRulesSchemaAvailable(true);
    }

    if (!requiresFreeItemSchema || !error) {
      setFreeItemSchemaAvailable(requiresFreeItemSchema ? true : freeItemSchemaAvailable);
    }
    if (!requiresCtaTargetSchema || !error) {
      setCtaTargetSchemaAvailable(requiresCtaTargetSchema ? true : ctaTargetSchemaAvailable);
    }

    if (usedLegacyRulesFallback) {
      showToast('Offer saved. Run the latest offers migration to enable advanced offer rules.');
    } else if (usedLegacyDisplayFallback) {
      showToast(
        droppedDisplayFields
          ? 'Offer updated, but display-only fields were skipped because migrations 20260330120000, 20260330123000, and 20260331140000 are missing.'
          : 'Offer saved. Run the latest offers display migrations to enable promo-only cards, CTA text, and custom labels.',
      );
    } else {
      showToast(editing.id ? 'Offer updated' : 'Offer added');
    }
    setEditing(null);
    await loadOffers();
  }

  async function deleteOffer(id: string) {
    const { error } = await supabase.from('offers').delete().eq('id', id);
    if (error) {
      showToast(error.message || 'Failed to delete offer', 'error');
      return;
    }

    showToast('Offer deleted');
    await loadOffers();
  }

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-8 bg-brand-surface rounded w-32 mb-4" />
        <div className="h-40 bg-brand-surface rounded-xl" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Offers</h1>
          <p className="mt-1 text-sm text-brand-text-muted">
            The homepage carousel shows the newest 4 active offers from this list.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/admin/offers/bulk" className="btn-outline px-4 py-2 text-sm">
            <span className="inline-flex items-center gap-1">
              <Plus size={14} />
              Bulk Add
            </span>
          </Link>
          <button onClick={() => setEditing(buildEmptyOffer())} className="btn-primary px-4 py-2 text-sm">
            <span className="inline-flex items-center gap-1">
              <Plus size={14} />
              Add Offer
            </span>
          </button>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-brand-border bg-brand-surface p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Homepage carousel</h2>
            <p className="text-sm text-brand-text-muted">
              Add, edit, deactivate, or delete offers here to change the carousel. Only 4 active offers are shown at once.
            </p>
          </div>
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-gold">
            {carouselOffers.length}/4 slides filled
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => {
            const offer = carouselOffers[index];
            const requestedSlideBackgroundImage = normalizeImageUrl(offer?.background_image_url);
            const slideBackgroundImage = requestedSlideBackgroundImage && !failedImageUrls[requestedSlideBackgroundImage]
              ? requestedSlideBackgroundImage
              : null;

            return (
              <div
                key={index}
                className="relative overflow-hidden rounded-lg border border-brand-border bg-brand-bg/40 p-3"
              >
                {slideBackgroundImage && (
                  <>
                    <img
                      src={slideBackgroundImage}
                      alt={offer ? `${offer.title || 'Offer'} background preview` : 'Offer background preview'}
                      loading="lazy"
                      width={1200}
                      height={600}
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={() => markImageFailed(slideBackgroundImage)}
                    />
                    <div className="absolute inset-0 bg-gradient-to-r from-brand-bg/95 via-brand-bg/80 to-brand-bg/45" />
                  </>
                )}
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-text-dim">
                  Slide {index + 1}
                </p>
                <div className="relative">
                  {offer ? (
                    <>
                      {(() => {
                        const types: string[] = [];
                        if (offer.applies_to_delivery !== false) types.push('Delivery');
                        if (offer.applies_to_takeaway !== false) types.push('Takeaway');
                        if (offer.applies_to_dine_in !== false) types.push('Dine In');
                        if (types.length === 3) return null;
                        return (
                          <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-sky-400">
                            {types.length === 0 ? 'No order type' : types.join(' + ')}
                          </p>
                        );
                      })()}
                      {offer.title ? (
                        <p className="mt-1 text-sm font-bold text-white">{offer.title}</p>
                      ) : (
                        <p className="mt-1 text-xs italic text-brand-text-dim">Image-only poster</p>
                      )}
                      {getOfferDisplayDescription(offer) && (
                        <p className="mt-1 whitespace-pre-line text-xs text-brand-text-muted">
                          {getOfferDisplayDescription(offer)}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-brand-text-muted">
                      Empty slot. Add or activate another offer to fill this slide.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {displaySchemaAvailable === false && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-white">
            Background image URLs, CTA text, and custom offer labels are disabled because the `offers` table is missing the new display columns.
          </p>
          <p className="mt-1 text-xs text-brand-text-muted">
            Run this SQL once in the Supabase SQL Editor for the current project, then refresh this page.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-brand-bg/70 p-3 text-xs text-brand-text-muted">{DISPLAY_SCHEMA_SQL}</pre>
        </div>
      )}

      {rulesSchemaAvailable === false && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-white">
            Advanced automatic and quantity-based offers are disabled because the `offers` table is missing the rule-based columns.
          </p>
          <p className="mt-1 text-xs text-brand-text-muted">
            Run this SQL once in the Supabase SQL Editor for the current project, then refresh this page.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-brand-bg/70 p-3 text-xs text-brand-text-muted">{RULES_SCHEMA_SQL}</pre>
        </div>
      )}

      {freeItemSchemaAvailable === false && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-white">
            Buy-X-get-Y free item offers are disabled because the `offers` table is missing the new item-reward columns.
          </p>
          <p className="mt-1 text-xs text-brand-text-muted">
            Run this SQL once in the Supabase SQL Editor for the current project, then refresh this page.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-brand-bg/70 p-3 text-xs text-brand-text-muted">{FREE_ITEM_SCHEMA_SQL}</pre>
        </div>
      )}

      {ctaTargetSchemaAvailable === false && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-white">
            Banner button category and product links are disabled because the `offers` table is missing the CTA target columns.
          </p>
          <p className="mt-1 text-xs text-brand-text-muted">
            Run this SQL once in the Supabase SQL Editor for the current project, then refresh this page.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-brand-bg/70 p-3 text-xs text-brand-text-muted">{CTA_TARGET_SCHEMA_SQL}</pre>
        </div>
      )}

      {offerImageUploadAvailable === false && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-white">
            Offer image uploads are disabled because the `offer-images` storage bucket or its admin policies are missing.
          </p>
          <p className="mt-1 text-xs text-brand-text-muted">
            Run this SQL once in the Supabase SQL Editor for the current project, then retry the upload.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-brand-bg/70 p-3 text-xs text-brand-text-muted">{OFFER_IMAGE_STORAGE_SQL}</pre>
        </div>
      )}

      {editing && (
        <div className="bg-brand-surface rounded-xl border border-brand-border p-4 mb-6 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              placeholder="Offer Title (optional — internal name)"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className="input-field"
            />

            <label className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-bg/30 px-3 text-sm text-brand-text-muted">
              <input
                type="checkbox"
                checked={editing.is_cart_eligible}
                onChange={(e) => setEditing({
                  ...editing,
                  is_cart_eligible: e.target.checked,
                  offer_mode: e.target.checked ? editing.offer_mode : 'automatic',
                  code: e.target.checked ? editing.code : '',
                })}
                className="rounded"
              />
              Affects cart pricing and coupons
            </label>

            <div className="sm:col-span-2 rounded-xl border border-brand-border bg-brand-bg/20 p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-text-dim">Applies to order types</p>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2 text-sm text-brand-text-muted">
                  <input
                    type="checkbox"
                    checked={editing.applies_to_delivery}
                    onChange={(e) => setEditing({ ...editing, applies_to_delivery: e.target.checked })}
                    className="rounded"
                  />
                  Delivery
                </label>
                <label className="flex items-center gap-2 text-sm text-brand-text-muted">
                  <input
                    type="checkbox"
                    checked={editing.applies_to_takeaway}
                    onChange={(e) => setEditing({ ...editing, applies_to_takeaway: e.target.checked })}
                    className="rounded"
                  />
                  Takeaway
                </label>
                <label className="flex items-center gap-2 text-sm text-brand-text-muted">
                  <input
                    type="checkbox"
                    checked={editing.applies_to_dine_in}
                    onChange={(e) => setEditing({ ...editing, applies_to_dine_in: e.target.checked })}
                    className="rounded"
                  />
                  Dine In
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-brand-text-muted pt-1 border-t border-brand-border/50">
                <input
                  type="checkbox"
                  checked={editing.show_on_offers_page}
                  onChange={(e) => setEditing({ ...editing, show_on_offers_page: e.target.checked })}
                  className="rounded"
                />
                Show card on Offers page
              </label>
              <label className="flex items-center gap-2 text-sm text-brand-text-muted">
                <input
                  type="checkbox"
                  checked={editing.hide_text_overlay}
                  onChange={(e) => setEditing({ ...editing, hide_text_overlay: e.target.checked })}
                  className="rounded"
                />
                Hide all text on banner image (poster-only mode)
              </label>
            </div>

            <input
              placeholder="Top Badge (optional)"
              value={editing.display_badge}
              onChange={(e) => setEditing({ ...editing, display_badge: e.target.value })}
              disabled={displaySchemaAvailable === false}
              className="input-field"
            />

            <input
              placeholder="Bottom Highlight (optional, e.g. ₹149)"
              value={editing.display_reward}
              onChange={(e) => setEditing({ ...editing, display_reward: e.target.value })}
              disabled={displaySchemaAvailable === false}
              className="input-field"
            />

            <input
              placeholder="Button Text (optional, default: Order Now)"
              value={editing.cta_text}
              onChange={(e) => setEditing({ ...editing, cta_text: e.target.value })}
              disabled={displaySchemaAvailable === false}
              className="input-field sm:col-span-2"
            />

            <select
              value={editing.cta_target_type}
              onChange={(e) => setEditing({
                ...editing,
                cta_target_type: e.target.value as OfferCtaTargetType,
                cta_target_category_id: e.target.value === 'category' ? editing.cta_target_category_id : '',
                cta_target_menu_item_id: e.target.value === 'item' ? editing.cta_target_menu_item_id : '',
              })}
              className="input-field"
            >
              <option value="menu">Button Action: Open Menu</option>
              <option value="category">Button Action: Open Category</option>
              <option value="item">Button Action: Open Product</option>
            </select>

            {editing.cta_target_type === 'category' ? (
              <select
                value={editing.cta_target_category_id}
                onChange={(e) => setEditing({
                  ...editing,
                  cta_target_type: 'category',
                  cta_target_category_id: e.target.value,
                  cta_target_menu_item_id: '',
                })}
                className="input-field"
              >
                <option value="">Open Category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            ) : editing.cta_target_type === 'item' ? (
              <select
                value={editing.cta_target_menu_item_id}
                onChange={(e) => setEditing({
                  ...editing,
                  cta_target_type: 'item',
                  cta_target_menu_item_id: e.target.value,
                  cta_target_category_id: '',
                })}
                className="input-field"
              >
                <option value="">Open Product</option>
                {menuItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}{item.is_available ? '' : ' (Unavailable)'} - ₹{item.price}
                  </option>
                ))}
              </select>
            ) : (
              <div className="input-field flex items-center text-sm text-brand-text-dim">
                Button opens the full menu page.
              </div>
            )}

            <div className="sm:col-span-2 rounded-xl border border-brand-border bg-brand-bg/20 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  placeholder="Background Image URL (optional)"
                  value={editing.background_image_url}
                  onChange={(e) => setEditing({ ...editing, background_image_url: e.target.value })}
                  disabled={displaySchemaAvailable === false}
                  className="input-field flex-1"
                />
                <input
                  ref={backgroundImageInputRef}
                  type="file"
                  accept={ACCEPTED_OFFER_IMAGE_TYPES.join(',')}
                  onChange={handleBackgroundImageFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => backgroundImageInputRef.current?.click()}
                  disabled={displaySchemaAvailable === false || uploadingBackgroundImage}
                  className="btn-outline px-4 py-2 text-sm"
                >
                  {uploadingBackgroundImage ? 'Uploading...' : (
                    <span className="inline-flex items-center gap-1">
                      <ImagePlus size={14} />
                      Upload Image
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing({ ...editing, background_image_url: '' })}
                  disabled={!editing.background_image_url}
                  className="btn-outline px-4 py-2 text-sm"
                >
                  Clear Image
                </button>
              </div>
              <p className="mt-2 text-xs text-brand-text-dim">
                Upload a PNG, JPG, WEBP, or GIF up to 5 MB, or paste a direct public image URL.
              </p>
            </div>

            {editing.is_cart_eligible && (
              <select
                value={editing.offer_mode}
                onChange={(e) => setEditing({
                  ...editing,
                  offer_mode: e.target.value as OfferMode,
                  code: e.target.value === 'coupon' ? editing.code : '',
                })}
                className="input-field"
              >
                <option value="coupon">Coupon Code</option>
                <option value="automatic">Automatic Offer</option>
              </select>
            )}

            {editing.is_cart_eligible && editing.offer_mode === 'coupon' && (
              <input
                placeholder="Coupon Code"
                value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                className="input-field"
              />
            )}

            {editing.is_cart_eligible && (
              <>
                <select
                  value={editing.trigger_type}
                  onChange={(e) => setEditing({ ...editing, trigger_type: e.target.value as OfferTriggerType })}
                  className="input-field"
                >
                  <option value="min_order">Trigger: Minimum Order Value</option>
                  <option value="item_quantity">Trigger: Item Quantity</option>
                </select>

                <select
                  value={editing.discount_type}
                  onChange={(e) => setEditing({
                    ...editing,
                    discount_type: e.target.value as OfferDiscountType,
                    discount_value: e.target.value === 'free_item' || e.target.value === 'free_addons'
                      ? '0'
                      : editing.discount_value,
                  })}
                  className="input-field"
                >
                  <option value="percentage">Percentage Discount</option>
                  <option value="flat">Flat Amount Discount</option>
                  <option value="free_addons">Free Add-Ons</option>
                  <option value="free_item">Free Item</option>
                </select>

                {editing.discount_type !== 'free_addons' && editing.discount_type !== 'free_item' && (
                  <input
                    placeholder="Discount Value"
                    type="number"
                    value={editing.discount_value}
                    onChange={(e) => setEditing({ ...editing, discount_value: e.target.value })}
                    className="input-field"
                  />
                )}

                {editing.trigger_type === 'min_order' ? (
                  <input
                    placeholder="Minimum Order Value"
                    type="number"
                    value={editing.min_order}
                    onChange={(e) => setEditing({ ...editing, min_order: e.target.value })}
                    className="input-field"
                  />
                ) : (
                  <>
                    <input
                      placeholder={editing.discount_type === 'free_item' ? 'Buy Quantity' : 'Required Item Quantity'}
                      type="number"
                      min={1}
                      value={editing.required_item_quantity}
                      onChange={(e) => setEditing({ ...editing, required_item_quantity: e.target.value })}
                      className="input-field"
                    />
                    <input
                      placeholder="Minimum Order Value (optional)"
                      type="number"
                      min={0}
                      value={editing.min_order}
                      onChange={(e) => setEditing({ ...editing, min_order: e.target.value })}
                      className="input-field"
                    />
                  </>
                )}

                {editing.discount_type === 'free_item' && editing.trigger_type === 'item_quantity' && (
                  <>
                    <select
                      value={editing.qualifying_scope}
                      onChange={(e) => {
                        const nextScope = e.target.value as OfferQualifyingScope;
                        setEditing((current) => {
                          if (!current) return current;
                          return {
                            ...current,
                            qualifying_scope: nextScope,
                            qualifying_category_id: nextScope === 'category' ? current.qualifying_category_id : '',
                            qualifying_menu_item_id: nextScope === 'item' ? current.qualifying_menu_item_id : '',
                          };
                        });
                      }}
                      className="input-field"
                    >
                      <option value="item">Buy From: Specific Item</option>
                      <option value="category">Buy From: Any Item In Category</option>
                    </select>

                    {editing.qualifying_scope === 'category' ? (
                      <select
                        value={editing.qualifying_category_id}
                        onChange={(e) => setEditing((current) => {
                          if (!current) return current;
                          return {
                            ...current,
                            qualifying_scope: 'category',
                            qualifying_category_id: e.target.value,
                            qualifying_menu_item_id: '',
                          };
                        })}
                        className="input-field"
                      >
                        <option value="">Buy Category</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        value={editing.qualifying_menu_item_id}
                        onChange={(e) => setEditing((current) => {
                          if (!current) return current;
                          return {
                            ...current,
                            qualifying_scope: 'item',
                            qualifying_menu_item_id: e.target.value,
                            qualifying_category_id: '',
                          };
                        })}
                        className="input-field"
                      >
                        <option value="">Buy Item</option>
                        {menuItems.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}{item.is_available ? '' : ' (Unavailable)'} - ₹{item.price}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                )}

                {editing.discount_type === 'free_item' && (
                  <>
                    <select
                      value={editing.reward_item_source}
                      onChange={(e) => setEditing((current) => {
                        if (!current) return current;
                        const nextSource = e.target.value as OfferRewardItemSource;
                        return {
                          ...current,
                          reward_item_source: nextSource,
                          reward_menu_item_id: nextSource === 'specific_item' ? current.reward_menu_item_id : '',
                          trigger_type: nextSource === 'qualifying_item' ? 'item_quantity' : current.trigger_type,
                        };
                      })}
                      className="input-field"
                    >
                      <option value="specific_item">Free Reward: Specific Item</option>
                      <option value="qualifying_item">Free Reward: Same As Bought Item</option>
                    </select>

                    {editing.reward_item_source === 'specific_item' ? (
                      <select
                        value={editing.reward_menu_item_id}
                        onChange={(e) => setEditing({ ...editing, reward_menu_item_id: e.target.value })}
                        className="input-field"
                      >
                        <option value="">Free Item</option>
                        {menuItems.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}{item.is_available ? '' : ' (Unavailable)'} - ₹{item.price}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                        Customers will get the same item they bought for free automatically. Example: buy Vanilla Milkshake, get Vanilla Milkshake free.
                      </div>
                    )}

                    <input
                      placeholder="Free Quantity"
                      type="number"
                      min={1}
                      value={editing.reward_item_quantity}
                      onChange={(e) => setEditing({ ...editing, reward_item_quantity: e.target.value })}
                      className="input-field"
                    />
                  </>
                )}
              </>
            )}

            <input
              type="datetime-local"
              value={editing.valid_from}
              onChange={(e) => setEditing({ ...editing, valid_from: e.target.value })}
              className="input-field"
            />

            <input
              type="datetime-local"
              value={editing.valid_until}
              onChange={(e) => setEditing({ ...editing, valid_until: e.target.value })}
              className="input-field"
            />

            <label className="flex items-center gap-2 text-sm text-brand-text-muted">
              <input
                type="checkbox"
                checked={editing.is_active}
                onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                className="rounded"
              />
              Active
            </label>
          </div>

          <textarea
            placeholder="Description / combo lines"
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            className="input-field resize-none"
            rows={4}
          />

          <div className="rounded-lg border border-brand-border bg-brand-bg/40 p-3">
            <p className="mb-2 text-xs text-brand-text-dim">
              Use line breaks in the description to list combo items exactly as they should appear on the banner.
            </p>
            <p className="mb-2 whitespace-pre-line text-xs text-brand-text-dim">
              Example:
              {'\n'}Kurkure Momos (6 pcs)
              {'\n'}Any Milkshake
            </p>
            <p className="text-xs text-brand-text-dim">
              Add a background image URL or upload an image to show promo art behind the slide text on Home and Menu.
            </p>
            <p className="mt-2 text-xs text-brand-text-dim">
              Button Text lets you replace `Order Now` with a custom CTA like `Claim Offer` or `Get Free Shake`.
            </p>
            <p className="mt-2 text-xs text-brand-text-dim">
              Button Action lets the banner CTA open the full menu, a specific category, or a specific product.
            </p>
            <p className="mt-2 text-xs text-brand-text-dim">
              For buy-X-get-Y offers: choose `Trigger: Item Quantity`, pick `Free Item`, then choose either a fixed free item or `Same As Bought Item` for offers like buy 1 milkshake get the same milkshake free.
            </p>
            <p className="mt-2 text-xs text-brand-text-dim">
              You can also set `Minimum Order Value` together with `Trigger: Item Quantity` if the free item should unlock only after both conditions are met.
            </p>
            {displaySchemaAvailable === false && (
              <p className="mt-2 text-xs text-amber-300">
                Background image, CTA text, and label fields are currently disabled until the display-field migration is applied in Supabase.
              </p>
            )}
            {freeItemSchemaAvailable === false && (
              <p className="mt-2 text-xs text-amber-300">
                Free item promotions need the latest free-item migrations, including `20260408120000_add_offer_reward_item_source.sql`, before they can be saved.
              </p>
            )}
            {ctaTargetSchemaAvailable === false && (
              <p className="mt-2 text-xs text-amber-300">
                Banner category and product links need migration `20260401131500_add_offer_cta_targets.sql` before they can be saved.
              </p>
            )}
            {offerImageUploadAvailable === false && (
              <p className="mt-2 text-xs text-amber-300">
                Image uploads need the `offer-images` storage migration before the Upload Image button will work.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-brand-border bg-brand-bg/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-text-dim mb-1">Preview</p>
            {previewOffer && (
              <div className="relative overflow-hidden rounded-xl border border-brand-border bg-brand-surface-light/30 p-3">
                {normalizeImageUrl(previewOffer.background_image_url) && !failedImageUrls[normalizeImageUrl(previewOffer.background_image_url) as string] && (
                  <>
                    <img
                      src={normalizeImageUrl(previewOffer.background_image_url) as string}
                      alt={`${previewOffer.title} offer preview background`}
                      loading="lazy"
                      width={1200}
                      height={600}
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={() => markImageFailed(normalizeImageUrl(previewOffer.background_image_url) as string)}
                    />
                    <div className="absolute inset-0 bg-gradient-to-r from-brand-bg/95 via-brand-surface/85 to-brand-surface/35" />
                  </>
                )}
                <div className="relative flex flex-wrap items-center gap-2">
                  <span className="inline-block rounded-md bg-brand-gold/20 px-2.5 py-1 text-[11px] font-bold tracking-wide text-brand-gold">
                    {getOfferBadgeLabel(previewOffer)}
                  </span>
                  <span className="text-[11px] text-brand-text-dim">
                    {isOfferCartEligible(previewOffer)
                      ? (getOfferMode(previewOffer) === 'automatic' ? 'Auto applied' : 'Coupon')
                      : 'Display only'}
                  </span>
                  {(() => {
                    const types: string[] = [];
                    if (previewOffer.applies_to_delivery !== false) types.push('Delivery');
                    if (previewOffer.applies_to_takeaway !== false) types.push('Takeaway');
                    if (previewOffer.applies_to_dine_in !== false) types.push('Dine In');
                    if (types.length === 3) return null;
                    if (types.length === 0) return (
                      <span className="text-[11px] font-bold text-red-400">No order types</span>
                    );
                    return (
                      <span className="text-[11px] font-bold text-sky-400">{types.join(' + ')} only</span>
                    );
                  })()}
                  {previewOffer.show_on_offers_page === false && (
                    <span className="text-[11px] font-semibold text-brand-text-dim">Hidden from Offers page</span>
                  )}
                  {previewOffer.hide_text_overlay && (
                    <span className="text-[11px] font-bold text-amber-400">Text hidden on image</span>
                  )}
                </div>
                {previewOffer.title ? (
                  <p className="relative mt-2 text-sm font-bold text-white">{previewOffer.title}</p>
                ) : (
                  <p className="relative mt-2 text-xs italic text-brand-text-dim">No title — image-only poster</p>
                )}
                {previewDescription && (
                  <p className="relative mt-1 whitespace-pre-line text-sm text-brand-text-muted">
                    {previewDescription}
                  </p>
                )}
                {!previewDescription && isOfferCartEligible(previewOffer) && (
                  <p className="relative mt-1 text-sm text-brand-text-muted">{getOfferRuleSummary(previewOffer)}</p>
                )}
                {previewRewardLabel && (
                  <p className="relative mt-3 text-lg font-black tracking-tight text-brand-gold">{previewRewardLabel}</p>
                )}
                <div className="relative mt-3">
                  <span className="inline-flex rounded-lg bg-brand-gold px-3 py-1.5 text-xs font-bold text-brand-bg">
                    {previewOffer.cta_text?.trim() || 'Order Now'}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={saveOffer} className="btn-primary text-sm px-4 py-2 flex items-center gap-1">
              <Save size={14} />{editing.id ? 'Update' : 'Add'}
            </button>
            <button onClick={() => setEditing(null)} className="btn-outline text-sm px-4 py-2 flex items-center gap-1">
              <X size={14} />Cancel
            </button>
          </div>
        </div>
      )}

      {offers.length === 0 ? (
        <div className="bg-brand-surface rounded-xl border border-brand-border p-10 text-center text-brand-text-muted">No offers</div>
      ) : (
        <div className="space-y-3">
          {offers.map((offer) => {
            const carouselPosition = carouselOffers.findIndex((carouselOffer) => carouselOffer.id === offer.id);
            const rewardLabel = getOfferRewardLabel(offer);
            const description = getOfferDisplayDescription(offer);
            const requestedBackgroundImageUrl = normalizeImageUrl(offer.background_image_url);
            const backgroundImageUrl = requestedBackgroundImageUrl && !failedImageUrls[requestedBackgroundImageUrl]
              ? requestedBackgroundImageUrl
              : null;

            return (
              <div key={offer.id} className="bg-brand-surface rounded-xl border border-brand-border p-4 flex items-start gap-4">
                {backgroundImageUrl ? (
                  <img
                    src={backgroundImageUrl}
                    alt={`${offer.title || 'Offer'} thumbnail`}
                    loading="lazy"
                    width={56}
                    height={56}
                    className="h-14 w-14 rounded-xl object-cover flex-shrink-0"
                    onError={() => markImageFailed(backgroundImageUrl)}
                  />
                ) : (
                  <div className="w-14 h-14 bg-brand-gold/10 rounded-xl flex items-center justify-center flex-shrink-0">
                    <span className="text-brand-gold font-black text-[11px] text-center leading-tight px-1">
                      {rewardLabel || 'PROMO'}
                    </span>
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-sm text-white">{offer.title || '(Untitled — poster)'}</h3>
                    <span className="bg-brand-surface-light text-brand-text-muted text-xs px-2 py-0.5 rounded font-mono">
                      {getOfferBadgeLabel(offer)}
                    </span>
                    <span className="text-xs text-brand-text-dim">
                      {isOfferCartEligible(offer)
                        ? (getOfferMode(offer) === 'automatic' ? 'Auto applied' : 'Coupon')
                        : 'Display only'}
                    </span>
                    {(() => {
                      const types: string[] = [];
                      if (offer.applies_to_delivery !== false) types.push('Delivery');
                      if (offer.applies_to_takeaway !== false) types.push('Takeaway');
                      if (offer.applies_to_dine_in !== false) types.push('Dine In');
                      if (types.length === 3) return null;
                      if (types.length === 0) return (
                        <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-400">No order type</span>
                      );
                      return types.map((t) => (
                        <span key={t} className="rounded bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-400">{t}</span>
                      ));
                    })()}
                    {offer.show_on_offers_page === false && (
                      <span className="rounded bg-brand-surface-light px-2 py-0.5 text-xs font-semibold text-brand-text-dim">Hidden</span>
                    )}
                    {offer.hide_text_overlay && (
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-400">Poster</span>
                    )}
                    {carouselPosition >= 0 && (
                      <span className="rounded bg-brand-gold/15 px-2 py-0.5 text-xs font-semibold text-brand-gold">
                        Homepage #{carouselPosition + 1}
                      </span>
                    )}
                    {!offer.is_active && <span className="text-xs text-brand-text-dim">Inactive</span>}
                  </div>
                    {description && (
                      <p className="mt-1 whitespace-pre-line text-xs text-brand-text-muted">
                        {description}
                      </p>
                    )}
                    {backgroundImageUrl && (
                      <p className="mt-1 text-[11px] text-brand-text-dim">Background image set</p>
                    )}
                </div>

                <div className="flex gap-1">
                  <button
                    onClick={() => setEditing(mapOfferToForm(offer))}
                    className="p-2 hover:bg-brand-surface-light/70 rounded text-brand-text-dim hover:text-white"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => void deleteOffer(offer.id)}
                    className="p-2 hover:bg-red-500/10 rounded text-brand-text-dim hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
