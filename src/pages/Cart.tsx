import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Minus, Plus, Trash2, ShoppingBag, ArrowLeft, Tag, User, Pencil, Store, Wallet, CreditCard, Gift, Mail, Phone, MapPin } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useCart } from '../contexts/CartContext';
import { useAuth } from '../contexts/AuthContext';
import { useSiteSettings } from '../hooks/useSiteSettings';
import {
  getApplicableAutomaticOffers,
  getCartAddOnTotal,
  getOfferBadgeLabel,
  getOfferCode,
  getOfferDiscountAmount,
  getOfferEligibilityError,
  getOfferMode,
  getOfferOrderTypeError,
  getOfferRewardItems,
  getOfferRuleSummary,
  isOfferApplicableToOrderType,
  isOfferCartEligible,
  type OfferRewardItem,
} from '../lib/offers';
import { customerSupabase } from '../lib/supabase';
import { readCheckoutSuccessOrder, storeCheckoutSuccessOrder } from '../lib/checkoutSuccess';
import { clearPendingOnlineOrder, readPendingOnlineOrder, storePendingOnlineOrder } from '../lib/pendingOnlineOrder';
import { saveCheckoutResume, readCheckoutResume, clearCheckoutResume } from '../lib/checkoutResume';
import { storeGuestOrderSnapshot, updateGuestOrderSnapshot } from '../lib/guestOrderSnapshot';
import { getCheckoutCustomerPhoneForApi, getRazorpayPrefillContact } from '../lib/checkoutCustomer';
import { getServiceModeLabel } from '../lib/orderLabels';
import { menuItemSupportsCustomizations } from '../lib/menuItems';
import { fetchCustomizationAvailability, itemHasAssignedCustomizations, type CustomizationAvailability } from '../lib/customizations';
import { createCounterOrder } from '../lib/counterOrder';
import { suggestCartAddOns } from '../lib/cartSuggestions';
import { calculateReviewRewardDiscount } from '../lib/itemReviews';
import type { DeliveryZone, MenuItem, Order, OrderType, PaymentMethod, Offer, PickupOption, ReviewRewardCoupon, SelectedCustomization, MapConfirmData } from '../types';
import { useToast } from '../components/Toast';
import { RAZORPAY_BRAND_IMAGE, buildRazorpayCallbackUrl, cancelRazorpayPayment, createRazorpayOrder, loadRazorpayScript, verifyRazorpayPayment } from '../lib/razorpay';
import { playOrderSound } from '../lib/sounds';
import CustomizationModal from '../components/CustomizationModal';
import LocationPicker from '../components/LocationPicker';

const SESSION_KEYWORDS = ['session expired', 'sign in again', 'please sign in'];
const TAKEAWAY_CHARGE = 10;
const DELIVERY_CHECKOUT_ENABLED = true;
const FREE_DELIVERY_THRESHOLD = 299;
const RESTAURANT_LAT = 16.4724;
const RESTAURANT_LNG = 80.6516;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getDistanceBasedDeliveryFee(lat: number | null, lng: number | null): number {
  if (lat === null || lng === null) return 30;
  const km = haversineKm(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng);
  if (km <= 3) return 30;
  if (km <= 7) return 50;
  return 70;
}
const AI_SUGGESTION_DEBOUNCE_MS = 350;
const WATER_ITEM_KEYWORDS = ['water bottle', 'water bottles', 'mineral water', 'bottled water', 'bisleri', 'aquafina', 'kinley'];
const WATER_CATEGORY_KEYWORDS = ['water bottle', 'water bottles', 'mineral water', 'bottled water'];
const COOL_DRINK_ITEM_KEYWORDS = [
  'cool drink',
  'cool drinks',
  'cold drink',
  'cold drinks',
  'soft drink',
  'soft drinks',
  'cold coffee',
  'iced tea',
  'ice tea',
  'mojito',
  'juice',
  'soda',
  'cola',
  'coke',
  'sprite',
  'fanta',
  'thums up',
  'limca',
  'maaza',
  'milkshake',
  'thick shake',
  'shake',
];
const COOL_DRINK_CATEGORY_KEYWORDS = [
  'cool drink',
  'cool drinks',
  'cold drink',
  'cold drinks',
  'soft drink',
  'soft drinks',
  'beverage',
  'beverages',
  'drinks',
  'milkshake',
  'milkshakes',
  'thick shake',
  'thick shakes',
  'shake',
  'shakes',
  'juice',
  'juices',
  'soda',
];
const SNACK_TRIGGER_ITEM_KEYWORDS = [
  'fries',
  'french fries',
  'peri peri',
  'momos',
  'momo',
  'nuggets',
  'popcorn chicken',
  'chicken popcorn',
  'hot dog',
  'burger',
  'sandwich',
  'roll',
  'wrap',
  'chaat',
  'chat',
  'snack',
];
const SNACK_TRIGGER_CATEGORY_KEYWORDS = [
  'fries',
  'momos',
  'momo',
  'snacks',
  'snack',
  'chicken snacks',
  'chicken momos',
  'chaat',
  'chat',
  'hot dog',
  'burger',
  'sandwich',
  'roll',
  'wrap',
  'savory',
];

type OfferMenuCatalogItem = MenuItem;
type RefreshmentSuggestion = {
  menuItem: OfferMenuCatalogItem;
  reason: string | null;
};
type CheckoutOrderType = OrderType;
type CheckoutStep = 'service' | 'coupon' | 'payment';

function getPromoRewardSummary(items: OfferRewardItem[]) {
  return items.map((item) => `${item.quantity}x ${item.item_name}`).join(', ');
}

function normalizeCatalogText(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function matchesKeyword(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function isWaterBottleLike(item: Pick<MenuItem, 'name'>, categoryName?: string) {
  const itemText = normalizeCatalogText(item.name);
  const categoryText = normalizeCatalogText(categoryName);
  return matchesKeyword(itemText, WATER_ITEM_KEYWORDS) || matchesKeyword(categoryText, WATER_CATEGORY_KEYWORDS);
}

function isCoolDrinkLike(item: Pick<MenuItem, 'name'>, categoryName?: string) {
  const itemText = normalizeCatalogText(item.name);
  const categoryText = normalizeCatalogText(categoryName);
  return matchesKeyword(itemText, COOL_DRINK_ITEM_KEYWORDS) || matchesKeyword(categoryText, COOL_DRINK_CATEGORY_KEYWORDS);
}

function isSnackSuggestionTrigger(item: Pick<MenuItem, 'name'>, categoryName?: string) {
  const itemText = normalizeCatalogText(item.name);
  const categoryText = normalizeCatalogText(categoryName);
  return matchesKeyword(itemText, SNACK_TRIGGER_ITEM_KEYWORDS) || matchesKeyword(categoryText, SNACK_TRIGGER_CATEGORY_KEYWORDS);
}

function getRefreshmentSuggestionLabel(item: Pick<MenuItem, 'name'>, categoryName?: string) {
  if (isWaterBottleLike(item, categoryName)) {
    return 'Water bottle add-on';
  }

  if (isCoolDrinkLike(item, categoryName)) {
    return 'Cool drink pick';
  }

  return categoryName || 'Suggested add-on';
}

export default function CartPage() {
  const { items, subtotal, itemCount, removeItem, updateQuantity, clearCart, addItem } = useCart();
  const { user, profile } = useAuth();
  const { settings } = useSiteSettings();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [orderType, setOrderType] = useState<CheckoutOrderType>('pickup');
  const [pickupOption, setPickupOption] = useState<PickupOption>('dine_in');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryPincode, setDeliveryPincode] = useState('');
  const [deliveryLat, setDeliveryLat] = useState<number | null>(null);
  const [deliveryLng, setDeliveryLng] = useState<number | null>(null);
  // Extended address fields from MapLocationPicker
  const [deliveryHouseNumber, setDeliveryHouseNumber]           = useState('');
  const [deliveryBuildingName, setDeliveryBuildingName]         = useState('');
  const [deliveryFloorNumber, setDeliveryFloorNumber]           = useState('');
  const [deliveryLandmark, setDeliveryLandmark]                 = useState('');
  const [deliveryInstructions, setDeliveryInstructions]         = useState('');
  const [detectedGpsLat, setDetectedGpsLat]                     = useState<number | null>(null);
  const [detectedGpsLng, setDetectedGpsLng]                     = useState<number | null>(null);
  const [addressConfidence, setAddressConfidence]               = useState<number>(0);
  const [savedAddressId, setSavedAddressId]                     = useState<string | undefined>(undefined);
  const [deliveryZone, setDeliveryZone] = useState<DeliveryZone | null>(null);
  const [deliveryLookupLoading, setDeliveryLookupLoading] = useState(false);
  const [deliveryLookupError, setDeliveryLookupError] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card');
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep | null>(null);
  const [activeOffers, setActiveOffers] = useState<Offer[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [appliedOffer, setAppliedOffer] = useState<Offer | null>(null);
  const [selectedAutomaticOfferId, setSelectedAutomaticOfferId] = useState<string | null>(null);
  const [reviewRewardCoupons, setReviewRewardCoupons] = useState<ReviewRewardCoupon[]>([]);
  const [selectedReviewRewardCouponId, setSelectedReviewRewardCouponId] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingItem, setEditingItem] = useState<{
    cartItemId: string;
    menuItem: MenuItem;
    quantity: number;
    customizations: SelectedCustomization[];
  } | null>(null);
  const [pendingSuggestedItem, setPendingSuggestedItem] = useState<{
    cartItemId: string;
    menuItem: MenuItem;
    quantity: number;
  } | null>(null);
  const [aiRefreshmentSuggestions, setAiRefreshmentSuggestions] = useState<RefreshmentSuggestion[] | null>(null);
  const [offerMenuItemsById, setOfferMenuItemsById] = useState<Record<string, OfferMenuCatalogItem>>({});
  const [offerCategoryNamesById, setOfferCategoryNamesById] = useState<Record<string, string>>({});
  const [menuCatalogLoaded, setMenuCatalogLoaded] = useState(false);
  const [customizationAvailability, setCustomizationAvailability] = useState<CustomizationAvailability | null>(null);
  const pendingSuccessOrderId = readCheckoutSuccessOrder();
  const pendingOnlineOrderId = readPendingOnlineOrder();
  const activeCheckoutOrderId = pendingSuccessOrderId || pendingOnlineOrderId;
  const activeOrderType: CheckoutOrderType = orderType;

  useEffect(() => {
    if (!user) return;
    const saved = readCheckoutResume();
    if (!saved) return;
    clearCheckoutResume();
    if (saved.name) setName(saved.name);
    if (saved.email) setEmail(saved.email);
    if (saved.phone) setPhone(saved.phone);
    setOrderType(saved.orderType);
    if (saved.deliveryAddress) setDeliveryAddress(saved.deliveryAddress);
    if (saved.deliveryPincode) setDeliveryPincode(saved.deliveryPincode);
    if (saved.deliveryLat !== null) setDeliveryLat(saved.deliveryLat);
    if (saved.deliveryLng !== null) setDeliveryLng(saved.deliveryLng);
    setCheckoutStep('service');
  }, [user]);

  useEffect(() => {
    if (profile) {
      if (profile.full_name && !name) setName(profile.full_name);
      if (profile.email && !email) setEmail(profile.email);
      if (profile.phone && !phone) setPhone(profile.phone.replace(/\D/g, '').slice(0, 10));
      if (profile.default_address && !deliveryAddress) setDeliveryAddress(profile.default_address);
      if (profile.default_pincode && !deliveryPincode) setDeliveryPincode(profile.default_pincode.replace(/\D/g, '').slice(0, 6));
    } else if (user?.email && !email) {
      setEmail(user.email);
    }
  }, [profile, user, name, email, phone, deliveryAddress, deliveryPincode]);

  useEffect(() => {
    const normalizedPincode = deliveryPincode.replace(/\D/g, '').slice(0, 6);

    if (normalizedPincode.length !== 6) {
      setDeliveryZone(null);
      setDeliveryLookupLoading(false);
      setDeliveryLookupError('');
      return;
    }

    let isMounted = true;
    setDeliveryLookupLoading(true);
    setDeliveryLookupError('');

    void (async () => {
      const { data, error } = await customerSupabase
        .from('delivery_zones')
        .select('*')
        .eq('pincode', normalizedPincode)
        .eq('is_active', true)
        .maybeSingle();

      if (!isMounted) {
        return;
      }

      if (error) {
        console.error('Failed to check delivery availability', error);
        setDeliveryZone(null);
        setDeliveryLookupError(error.message || 'Could not verify delivery availability');
        setDeliveryLookupLoading(false);
        return;
      }

      if (!data) {
        setDeliveryZone(null);
        setDeliveryLookupError('Sorry, we don\'t deliver to this pincode yet.');
        setDeliveryLookupLoading(false);
        return;
      }

      setDeliveryZone(data as DeliveryZone);
      setDeliveryLookupLoading(false);
    })();

    return () => {
      isMounted = false;
    };
  }, [deliveryPincode]);

  useEffect(() => {
    if (!user) {
      setReviewRewardCoupons([]);
      setSelectedReviewRewardCouponId(null);
      return;
    }

    let isMounted = true;

    void (async () => {
      const { data, error } = await customerSupabase
        .from('review_reward_coupons')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_redeemed', false)
        .order('created_at', { ascending: false });

      if (!isMounted) {
        return;
      }

      if (error) {
        console.error('Failed to load review reward coupons', error);
        setReviewRewardCoupons([]);
        return;
      }

      setReviewRewardCoupons(data || []);
    })();

    return () => {
      isMounted = false;
    };
  }, [user]);

  useEffect(() => {
    if (!activeCheckoutOrderId) return;
    navigate(`/order-success/${activeCheckoutOrderId}`, { replace: true });
  }, [activeCheckoutOrderId, navigate]);

  useEffect(() => {
    void (async () => {
      try {
        setCustomizationAvailability(await fetchCustomizationAvailability());
      } catch (error) {
        console.error('Failed to load customization availability', error);
      }
    })();
  }, []);

  const loadActiveOffers = useCallback(async () => {
    setMenuCatalogLoaded(false);
    const now = new Date().toISOString();
    const [offersRes, menuItemsRes, categoriesRes] = await Promise.all([
      customerSupabase
        .from('offers')
        .select('*')
        .eq('is_active', true)
        .lte('valid_from', now)
        .gte('valid_until', now)
        .order('created_at', { ascending: false }),
      customerSupabase
        .from('menu_items')
        .select('*'),
      customerSupabase
        .from('categories')
        .select('id, name'),
    ]);

    if (offersRes.error) {
      showToast(offersRes.error.message || 'Failed to load offers', 'error');
    }
    if (menuItemsRes.error) {
      showToast(menuItemsRes.error.message || 'Failed to validate current menu availability', 'error');
    }
    if (categoriesRes.error) {
      showToast(categoriesRes.error.message || 'Failed to load offer categories', 'error');
    }

    setActiveOffers((offersRes.data || []).filter(isOfferCartEligible));
    setOfferMenuItemsById(
      (menuItemsRes.data || []).reduce<Record<string, OfferMenuCatalogItem>>((acc, item) => {
        if (item.is_available !== false) {
          acc[item.id] = item;
        }
        return acc;
      }, {}),
    );
    setOfferCategoryNamesById(
      (categoriesRes.data || []).reduce<Record<string, string>>((acc, category) => {
        acc[category.id] = category.name;
        return acc;
      }, {}),
    );
    setMenuCatalogLoaded(!menuItemsRes.error);
  }, [showToast]);

  useEffect(() => {
    void loadActiveOffers();
  }, [loadActiveOffers]);

  async function applyCoupon() {
    setCouponError('');
    if (!couponCode.trim()) return;
    const matchingOffer = activeOffers.find((offer) => (
      getOfferMode(offer) === 'coupon' && getOfferCode(offer) === couponCode.trim().toUpperCase()
    ));

    if (!matchingOffer) {
      setCouponError('Invalid or expired coupon code');
      setAppliedOffer(null);
      return;
    }

    const offerEligibilityError = getOfferEligibilityError(matchingOffer, {
      subtotal,
      itemCount,
      addOnTotal: getCartAddOnTotal(items),
      items,
      menuItemsById: offerMenuItemsById,
      categoryNamesById: offerCategoryNamesById,
      orderType: activeOrderType,
      pickupOption,
    });

    if (offerEligibilityError) {
      setCouponError(offerEligibilityError);
      setAppliedOffer(null);
      return;
    }

    const offerOrderTypeError = getOfferOrderTypeError(matchingOffer, { subtotal, itemCount, addOnTotal: 0, orderType: activeOrderType, pickupOption });
    if (offerOrderTypeError) {
      setCouponError(offerOrderTypeError);
      setAppliedOffer(null);
      return;
    }

    setAppliedOffer(matchingOffer);
    showToast('Coupon applied!');
  }

  const addOnTotal = getCartAddOnTotal(items);
  const pricingContext = {
    subtotal,
    itemCount,
    addOnTotal,
    items,
    menuItemsById: offerMenuItemsById,
    categoryNamesById: offerCategoryNamesById,
    orderType: activeOrderType,
    pickupOption,
  };
  const couponRewardItems = appliedOffer ? getOfferRewardItems(appliedOffer, pricingContext) : [];
  const couponDiscount = appliedOffer ? getOfferDiscountAmount(appliedOffer, pricingContext) : 0;
  const applicableAutomaticOffers = getApplicableAutomaticOffers(activeOffers, pricingContext);
  const selectedAutomaticOffer = selectedAutomaticOfferId
    ? applicableAutomaticOffers.find((result) => result.offer.id === selectedAutomaticOfferId) || null
    : applicableAutomaticOffers.length === 1
      ? applicableAutomaticOffers[0]
      : null;
  const selectedReviewRewardCoupon = selectedReviewRewardCouponId
    ? reviewRewardCoupons.find((coupon) => coupon.id === selectedReviewRewardCouponId) || null
    : null;
  const automaticDiscount = selectedAutomaticOffer?.discountAmount || 0;
  const reviewRewardDiscount = selectedReviewRewardCoupon
    ? calculateReviewRewardDiscount(subtotal, Number(selectedReviewRewardCoupon.discount_percentage || 0))
    : 0;
  const automaticRewardItems = selectedAutomaticOffer?.freeItems || [];
  const promoRewardItems = [...couponRewardItems, ...automaticRewardItems];
  const checkoutItems = [
    ...items.map((item) => ({
      menu_item_id: item.menu_item.id,
      item_name: item.menu_item.name,
      quantity: item.quantity,
      unit_price: item.menu_item.price,
      customizations: item.customizations,
    })),
    ...promoRewardItems.map((item) => ({
      menu_item_id: item.menu_item_id,
      item_name: `${item.item_name} (Free)`,
      quantity: item.quantity,
      unit_price: 0,
      customizations: [] as SelectedCustomization[],
    })),
  ];
  const featuredAutomaticOffer = selectedAutomaticOffer?.offer || applicableAutomaticOffers[0]?.offer || activeOffers.find((offer) => getOfferMode(offer) === 'automatic' && isOfferApplicableToOrderType(offer, pricingContext)) || null;
  const discount = Math.min(subtotal, couponDiscount + automaticDiscount + reviewRewardDiscount);
  const deliveryFee = activeOrderType === 'delivery'
    ? (subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : getDistanceBasedDeliveryFee(deliveryLat, deliveryLng))
    : 0;
  const deliveryMinimumOrder = Number(deliveryZone?.min_order || 0);
  const deliveryEstimatedTime = Number(deliveryZone?.estimated_time || 0);

  function getTotalForCheckoutMode(checkoutOrderType: CheckoutOrderType, checkoutPickupOption: PickupOption) {
    const itemTotal = Math.max(0, subtotal - discount);
    if (checkoutOrderType === 'delivery') {
      return itemTotal + deliveryFee;
    }

    const optionTakeawayFee = checkoutPickupOption === 'takeaway' ? TAKEAWAY_CHARGE : 0;
    return itemTotal + optionTakeawayFee;
  }
  const takeawayFee = activeOrderType === 'pickup' && pickupOption === 'takeaway' ? TAKEAWAY_CHARGE : 0;
  const total = getTotalForCheckoutMode(activeOrderType, pickupOption);
  const isFreeOrder = total <= 0;
  const automaticOfferApplied = automaticDiscount > 0 || automaticRewardItems.length > 0;
  const multipleAutomaticOffersAvailable = applicableAutomaticOffers.length > 1;
  useEffect(() => {
    if (applicableAutomaticOffers.length === 0) {
      if (selectedAutomaticOfferId !== null) {
        setSelectedAutomaticOfferId(null);
      }
      return;
    }

    if (
      selectedAutomaticOfferId
      && applicableAutomaticOffers.some((result) => result.offer.id === selectedAutomaticOfferId)
    ) {
      return;
    }

    if (applicableAutomaticOffers.length === 1) {
      const onlyOfferId = applicableAutomaticOffers[0].offer.id;
      if (selectedAutomaticOfferId !== onlyOfferId) {
        setSelectedAutomaticOfferId(onlyOfferId);
      }
      return;
    }

    if (selectedAutomaticOfferId !== null) {
      setSelectedAutomaticOfferId(null);
    }
  }, [applicableAutomaticOffers, selectedAutomaticOfferId]);

  useEffect(() => {
    if (!selectedReviewRewardCouponId) {
      return;
    }

    if (!reviewRewardCoupons.some((coupon) => coupon.id === selectedReviewRewardCouponId)) {
      setSelectedReviewRewardCouponId(null);
    }
  }, [reviewRewardCoupons, selectedReviewRewardCouponId]);

  useEffect(() => {
    if (isFreeOrder || paymentMethod !== 'card') return;
    void loadRazorpayScript().catch((error) => {
      console.error('Failed to preload Razorpay checkout', error);
    });
  }, [isFreeOrder, paymentMethod]);

  useEffect(() => {
    if (!appliedOffer) return;

    const latestOffer = activeOffers.find((offer) => offer.id === appliedOffer.id) || appliedOffer;
    const revalidationContext = {
      subtotal,
      itemCount,
      addOnTotal,
      items,
      menuItemsById: offerMenuItemsById,
      categoryNamesById: offerCategoryNamesById,
      orderType: activeOrderType,
      pickupOption,
    };

    const orderTypeError = getOfferOrderTypeError(latestOffer, revalidationContext);
    if (orderTypeError) {
      setAppliedOffer(null);
      setCouponError(orderTypeError);
      return;
    }

    const offerEligibilityError = getOfferEligibilityError(latestOffer, revalidationContext);

    if (offerEligibilityError) {
      setAppliedOffer(null);
      setCouponError(`${latestOffer.title || 'This offer'} is no longer eligible for this cart`);
      return;
    }

    if (latestOffer !== appliedOffer) {
      setAppliedOffer(latestOffer);
    }
  }, [activeOffers, activeOrderType, addOnTotal, appliedOffer, itemCount, items, offerCategoryNamesById, offerMenuItemsById, pickupOption, subtotal]);

  useEffect(() => {
    if (!menuCatalogLoaded || items.length === 0) {
      return;
    }

    const unavailableCartItems = items.filter((item) => !offerMenuItemsById[item.menu_item.id]);

    if (unavailableCartItems.length === 0) {
      return;
    }

    unavailableCartItems.forEach((item) => removeItem(item.id));

    if (editingItem && unavailableCartItems.some((item) => item.id === editingItem.cartItemId)) {
      setEditingItem(null);
    }

    const unavailableNames = Array.from(new Set(unavailableCartItems.map((item) => item.menu_item.name)));
    showToast(
      unavailableNames.length === 1
        ? `${unavailableNames[0]} is out of stock and was removed from your cart`
        : `${unavailableNames.length} out-of-stock items were removed from your cart`,
      'error',
    );
  }, [editingItem, items, menuCatalogLoaded, offerMenuItemsById, removeItem, showToast]);

  function getCustomerEmail() {
    return email.trim() || profile?.email?.trim() || user?.email?.trim() || '';
  }

  async function syncProfileDetails() {
    if (!user) return;

    const { error: profileUpdateError } = await customerSupabase.from('profiles').update({
      full_name: name.trim(),
      email: getCustomerEmail(),
      phone: phone.trim() || profile?.phone || '',
      default_address: deliveryAddress.trim() || profile?.default_address || '',
      default_pincode: deliveryPincode.trim() || profile?.default_pincode || '',
    }).eq('id', user.id);

    if (profileUpdateError) {
      console.error('Failed to update profile before placing order', profileUpdateError);
    }
  }

  function redirectToVerifiedOrder(orderId: string, message = 'Order placed successfully') {
    clearPendingOnlineOrder(orderId);
    storeCheckoutSuccessOrder(orderId);
    showToast(message);
    playOrderSound();
    navigate(`/order-success/${orderId}`, { replace: true });
    clearCart();
  }

  function redirectToPendingOrder(orderId: string, message = 'Payment is being verified. We will update your order shortly.') {
    storePendingOnlineOrder(orderId);
    showToast(message);
    navigate(`/order-success/${orderId}`, { replace: true });
    clearCart();
  }

  async function startRazorpayCheckout(
    customerEmail: string,
    checkoutOrderType: CheckoutOrderType,
    checkoutPickupOption: PickupOption,
    checkoutAddress: string,
    checkoutPincode: string,
    checkoutDeliveryFee: number,
    checkoutTotal: number,
    checkoutDeliveryLat: number | null,
    checkoutDeliveryLng: number | null,
  ) {
    const razorpayScriptPromise = loadRazorpayScript();
    const checkoutServiceModeLabel = getServiceModeLabel({ order_type: checkoutOrderType, pickup_option: checkoutPickupOption });
    const customerName = name.trim();
    const customerPhone = getCheckoutCustomerPhoneForApi(phone);
    const razorpayOrder = await createRazorpayOrder({
      customerName,
      customerPhone,
      customerEmail,
      orderType: checkoutOrderType,
      pickupOption: checkoutPickupOption,
      address: checkoutAddress,
      pincode: checkoutPincode,
      deliveryFee: checkoutDeliveryFee,
      deliveryLat: checkoutDeliveryLat ?? undefined,
      deliveryLng: checkoutDeliveryLng ?? undefined,
      subtotal,
      discount,
      total: checkoutTotal,
      reviewRewardCouponId: selectedReviewRewardCoupon?.id,
      reviewRewardDiscountAmount: reviewRewardDiscount,
      items: checkoutItems,
    });
    const razorpayCallbackUrl = buildRazorpayCallbackUrl(razorpayOrder.appOrderId);
    storePendingOnlineOrder(razorpayOrder.appOrderId);
    if (!user) {
      storeGuestOrderSnapshot({
        orderId: razorpayOrder.appOrderId,
        customerName,
        customerEmail,
        orderType: checkoutOrderType,
        pickupOption: checkoutPickupOption,
        address: checkoutAddress,
        pincode: checkoutPincode,
        deliveryFee: checkoutDeliveryFee,
        subtotal,
        discount,
        total: checkoutTotal,
        paymentMethod: 'card',
        paymentProvider: 'razorpay',
        paymentStatus: 'pending',
      });
    }

    try {
      await razorpayScriptPromise;

      const RazorpayCheckout = window.Razorpay;
      if (!RazorpayCheckout) {
        throw new Error('Razorpay checkout is unavailable');
      }

      await new Promise<void>((resolve, reject) => {
        let paymentFinalized = false;

        const resolveCheckoutState = async (fallbackMessage: string) => {
          try {
            const cancellation = await cancelRazorpayPayment(razorpayOrder.appOrderId, razorpayOrder.customerEmail);

            if (cancellation.paymentState === 'paid') {
              updateGuestOrderSnapshot(cancellation.appOrderId || razorpayOrder.appOrderId, {
                payment_status: 'paid',
                payment_provider: 'razorpay',
                payment_method: cancellation.paymentMethod || 'card',
                payment_verified_at: new Date().toISOString(),
                ...(cancellation.orderStatus ? { status: cancellation.orderStatus as Order['status'] } : {}),
              });
              redirectToVerifiedOrder(cancellation.appOrderId || razorpayOrder.appOrderId);
              resolve();
              return;
            }

            if (cancellation.paymentState === 'pending') {
              redirectToPendingOrder(cancellation.appOrderId || razorpayOrder.appOrderId);
              resolve();
              return;
            }

            clearPendingOnlineOrder(razorpayOrder.appOrderId);
            reject(new Error(fallbackMessage));
          } catch (cancelError) {
            console.error('Failed to resolve Razorpay cancellation state', cancelError);
            clearPendingOnlineOrder(razorpayOrder.appOrderId);
            reject(new Error(fallbackMessage));
          }
        };

        const checkout = new RazorpayCheckout({
          key: razorpayOrder.keyId,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency,
          name: 'The Supreme Waffle',
          image: RAZORPAY_BRAND_IMAGE,
          description: `${checkoutServiceModeLabel} Order`,
          order_id: razorpayOrder.razorpayOrderId,
          prefill: {
            name: razorpayOrder.customerName,
            email: razorpayOrder.customerEmail,
            contact: getRazorpayPrefillContact(razorpayOrder.customerPhone),
          },
          notes: {
            app_order_id: razorpayOrder.appOrderId,
          },
          callback_url: razorpayCallbackUrl,
          redirect: true,
          theme: {
            color: '#D8B24E',
          },
          retry: {
            enabled: true,
            max_count: 2,
          },
          modal: {
            confirm_close: true,
            ondismiss: () => {
              if (paymentFinalized) return;
              paymentFinalized = true;
              void resolveCheckoutState('Payment cancelled');
            },
          },
          handler: (response) => {
            paymentFinalized = true;

            void (async () => {
              try {
                const verification = await verifyRazorpayPayment({
                  appOrderId: razorpayOrder.appOrderId,
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                  customerEmail: razorpayOrder.customerEmail,
                });

                const successfulOrderId = verification.appOrderId || razorpayOrder.appOrderId;
                if (verification.paymentState === 'failed') {
                  clearPendingOnlineOrder(successfulOrderId);
                  reject(new Error(verification.error || 'Payment verification failed'));
                  return;
                }

                if (verification.paymentState === 'pending') {
                  redirectToPendingOrder(successfulOrderId);
                  resolve();
                  return;
                }

                updateGuestOrderSnapshot(successfulOrderId, {
                  payment_status: 'paid',
                  payment_provider: 'razorpay',
                  payment_method: verification.paymentMethod || 'card',
                  payment_verified_at: new Date().toISOString(),
                  ...(verification.orderStatus ? { status: verification.orderStatus as Order['status'] } : {}),
                });
                redirectToVerifiedOrder(successfulOrderId);
                resolve();
              } catch (verificationError) {
                console.error('Failed to verify Razorpay payment, retrying once...', verificationError);
                await new Promise((r) => setTimeout(r, 2000));
                try {
                  const retryVerification = await verifyRazorpayPayment({
                    appOrderId: razorpayOrder.appOrderId,
                    razorpayOrderId: response.razorpay_order_id,
                    razorpayPaymentId: response.razorpay_payment_id,
                    razorpaySignature: response.razorpay_signature,
                    customerEmail: razorpayOrder.customerEmail,
                  });
                  const retryOrderId = retryVerification.appOrderId || razorpayOrder.appOrderId;
                  if (retryVerification.paymentState === 'paid') {
                    updateGuestOrderSnapshot(retryOrderId, {
                      payment_status: 'paid',
                      payment_provider: 'razorpay',
                      payment_method: retryVerification.paymentMethod || 'card',
                      payment_verified_at: new Date().toISOString(),
                      ...(retryVerification.orderStatus ? { status: retryVerification.orderStatus as Order['status'] } : {}),
                    });
                    redirectToVerifiedOrder(retryOrderId);
                    resolve();
                    return;
                  }
                  redirectToPendingOrder(retryOrderId, 'Payment received. We are verifying your order.');
                  resolve();
                } catch (retryError) {
                  console.error('Retry also failed, falling back to pending reconciliation', retryError);
                  redirectToPendingOrder(razorpayOrder.appOrderId, 'Payment received. We are verifying your order.');
                  resolve();
                }
              }
            })();
          },
        });

        checkout.on('payment.failed', (failure) => {
          if (paymentFinalized) return;
          paymentFinalized = true;
          void resolveCheckoutState(failure.error?.description || 'Payment failed');
        });

        checkout.open();
      });
    } catch (razorpayCheckoutError) {
      const cancellation = await cancelRazorpayPayment(razorpayOrder.appOrderId, razorpayOrder.customerEmail).catch((cancelError) => {
        console.error('Failed to cancel Razorpay order after checkout setup error', cancelError);
        return null;
      });

      if (cancellation?.paymentState === 'paid') {
        updateGuestOrderSnapshot(cancellation.appOrderId || razorpayOrder.appOrderId, {
          payment_status: 'paid',
          payment_provider: 'razorpay',
          payment_method: cancellation.paymentMethod || 'card',
          payment_verified_at: new Date().toISOString(),
          ...(cancellation.orderStatus ? { status: cancellation.orderStatus as Order['status'] } : {}),
        });
        redirectToVerifiedOrder(cancellation.appOrderId || razorpayOrder.appOrderId);
        return;
      }

      if (cancellation?.paymentState === 'pending') {
        redirectToPendingOrder(cancellation.appOrderId || razorpayOrder.appOrderId);
        return;
      }

      clearPendingOnlineOrder(razorpayOrder.appOrderId);
      throw razorpayCheckoutError;
    }
  }

  function validateCheckoutAvailability() {
    if (settings && !settings.site_is_open) {
      showToast(settings.reopening_text || 'Ordering is currently unavailable', 'error');
      return false;
    }

    return true;
  }

  function validateCustomerDetails() {
    const customerEmail = getCustomerEmail();

    if (!name.trim()) {
      showToast('Please enter your name', 'error');
      return false;
    }

    if (!customerEmail || !isValidEmail(customerEmail)) {
      showToast('Please enter a valid email for your receipt', 'error');
      return false;
    }

    return true;
  }

  function validateDeliveryDetails() {
    if (!DELIVERY_CHECKOUT_ENABLED || activeOrderType !== 'delivery') {
      return true;
    }

    if (!user) {
      showToast('Please sign in to use delivery', 'error');
      saveCheckoutResume({
        name,
        email,
        phone,
        orderType: 'delivery',
        deliveryAddress,
        deliveryPincode,
        deliveryLat,
        deliveryLng,
      });
      setCheckoutStep(null);
      navigate('/auth', { state: { from: '/cart' } });
      return false;
    }

    if (phone.replace(/\D/g, '').length !== 10) {
      showToast('Please enter a valid 10-digit mobile number', 'error');
      return false;
    }

    if (!deliveryAddress.trim()) {
      showToast('Please select or enter your delivery address', 'error');
      return false;
    }

    if (deliveryPincode.trim().length !== 6) {
      showToast('Please enter a valid 6-digit delivery pincode', 'error');
      return false;
    }

    if (deliveryLookupLoading) {
      showToast('Checking delivery availability for your pincode', 'error');
      return false;
    }

    if (!deliveryZone) {
      showToast(deliveryLookupError || 'Delivery is not available for this pincode yet', 'error');
      return false;
    }

    if (subtotal < deliveryMinimumOrder) {
      showToast(`Minimum order for ${deliveryZone.area_name} is ₹${deliveryMinimumOrder.toFixed(0)}`, 'error');
      return false;
    }

    return true;
  }

  function handleCheckoutStart() {
    if (submitting || !validateCheckoutAvailability()) {
      return;
    }

    setCheckoutStep('service');
  }

  function closeCheckoutFlow() {
    if (!submitting) {
      setCheckoutStep(null);
    }
  }

  function handlePickupChoice(option: PickupOption) {
    if (submitting || !validateCheckoutAvailability()) {
      return;
    }

    setPickupOption(option);
  }

  function handleOrderTypeChoice(nextOrderType: CheckoutOrderType) {
    if (submitting || !validateCheckoutAvailability()) {
      return;
    }

    setOrderType(nextOrderType);
    if (nextOrderType === 'delivery') {
      setPaymentMethod('card');
    }
  }

  function handleServiceContinue() {
    if (submitting || !validateCheckoutAvailability()) return;

    if (DELIVERY_CHECKOUT_ENABLED && activeOrderType === 'delivery') {
      if (!user) {
        showToast('Please sign in to use delivery', 'error');
        saveCheckoutResume({ name, email, phone, orderType: 'delivery', deliveryAddress, deliveryPincode, deliveryLat, deliveryLng });
        setCheckoutStep(null);
        navigate('/auth', { state: { from: '/cart' } });
        return;
      }
      if (!deliveryAddress.trim()) {
        showToast('Please select or enter your delivery address', 'error');
        return;
      }
      if (deliveryPincode.trim().length !== 6) {
        showToast('Please enter a valid 6-digit delivery pincode', 'error');
        return;
      }
      if (deliveryLookupLoading) {
        showToast('Checking delivery availability for your pincode', 'error');
        return;
      }
      if (!deliveryZone) {
        showToast(deliveryLookupError || 'Delivery is not available for this pincode yet', 'error');
        return;
      }
      if (subtotal < deliveryMinimumOrder) {
        showToast(`Minimum order for ${deliveryZone.area_name} is ₹${deliveryMinimumOrder.toFixed(0)}`, 'error');
        return;
      }
    }

    setCheckoutStep('coupon');
  }

  function handleCouponContinue() {
    if (submitting) return;
    setCheckoutStep('payment');
  }

  function handlePaymentChoice(method: PaymentMethod) {
    if (submitting || !validateCheckoutAvailability()) {
      return;
    }

    setPaymentMethod(method);
  }

  function handlePaymentContinue() {
    if (submitting || !validateCheckoutAvailability() || !validateDeliveryDetails() || !validateCustomerDetails()) {
      return;
    }

    setCheckoutStep(null);
    void submitCheckout(activeOrderType, pickupOption, paymentMethod);
  }

  async function submitCheckout(
    checkoutOrderType = activeOrderType,
    checkoutPickupOption = pickupOption,
    checkoutPaymentMethod = paymentMethod,
  ) {
    if (!validateCheckoutAvailability() || !validateDeliveryDetails() || !validateCustomerDetails()) {
      return;
    }

    setSubmitting(true);

    try {
      const checkoutAddress = checkoutOrderType === 'delivery' ? deliveryAddress.trim() : '';
      const checkoutPincode = checkoutOrderType === 'delivery' ? deliveryPincode.trim() : '';
      const checkoutDeliveryLat = checkoutOrderType === 'delivery' ? deliveryLat : null;
      const checkoutDeliveryLng = checkoutOrderType === 'delivery' ? deliveryLng : null;
      const checkoutDeliveryFee = checkoutOrderType === 'delivery'
        ? (subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : getDistanceBasedDeliveryFee(checkoutDeliveryLat, checkoutDeliveryLng))
        : 0;
      const checkoutTotal = getTotalForCheckoutMode(checkoutOrderType, checkoutPickupOption);
      const checkoutIsFreeOrder = checkoutTotal <= 0;
      const customerEmail = getCustomerEmail();
      void syncProfileDetails().catch((error) => {
        console.error('Failed to sync profile details during checkout', error);
      });

      if (checkoutPaymentMethod === 'card' && !checkoutIsFreeOrder) {
        await startRazorpayCheckout(
          customerEmail,
          checkoutOrderType,
          checkoutPickupOption,
          checkoutAddress,
          checkoutPincode,
          checkoutDeliveryFee,
          checkoutTotal,
          checkoutDeliveryLat,
          checkoutDeliveryLng,
        );
        return;
      }

      const order = await createCounterOrder({
        customerName: name.trim(),
        customerPhone: getCheckoutCustomerPhoneForApi(phone),
        customerEmail,
        orderType: checkoutOrderType,
        pickupOption: checkoutPickupOption,
        address: checkoutAddress,
        pincode: checkoutPincode,
        deliveryFee: checkoutDeliveryFee,
        deliveryLat: checkoutDeliveryLat ?? undefined,
        deliveryLng: checkoutDeliveryLng ?? undefined,
        houseNumber: checkoutOrderType === 'delivery' ? deliveryHouseNumber : undefined,
        buildingName: checkoutOrderType === 'delivery' ? deliveryBuildingName : undefined,
        floorNumber: checkoutOrderType === 'delivery' ? deliveryFloorNumber : undefined,
        landmark: checkoutOrderType === 'delivery' ? deliveryLandmark : undefined,
        deliveryInstructions: checkoutOrderType === 'delivery' ? deliveryInstructions : undefined,
        detectedGpsLat: checkoutOrderType === 'delivery' ? (detectedGpsLat ?? undefined) : undefined,
        detectedGpsLng: checkoutOrderType === 'delivery' ? (detectedGpsLng ?? undefined) : undefined,
        addressConfidence: checkoutOrderType === 'delivery' ? addressConfidence : undefined,
        savedAddressId: checkoutOrderType === 'delivery' ? savedAddressId : undefined,
        subtotal,
        discount,
        total: checkoutTotal,
        paymentMethod: checkoutPaymentMethod,
        reviewRewardCouponId: selectedReviewRewardCoupon?.id,
        reviewRewardDiscountAmount: reviewRewardDiscount,
        items: checkoutItems,
      });

      if (!user) {
        storeGuestOrderSnapshot({
          orderId: order.appOrderId,
          customerName: name.trim(),
          customerEmail,
          orderType: checkoutOrderType,
          pickupOption: checkoutPickupOption,
          address: checkoutAddress,
          pincode: checkoutPincode,
          deliveryFee: checkoutDeliveryFee,
          subtotal,
          discount,
          total: checkoutTotal,
          paymentMethod: checkoutPaymentMethod,
          paymentProvider: null,
          paymentStatus: checkoutIsFreeOrder ? 'paid' : 'pending',
        });
      }

      storeCheckoutSuccessOrder(order.appOrderId);
      showToast('Order placed successfully');
      playOrderSound();
      navigate(`/order-success/${order.appOrderId}`, { replace: true });
      clearCart();
    } catch (placeOrderError) {
      console.error('Unexpected order placement error', placeOrderError);
      const message = placeOrderError instanceof Error
        ? placeOrderError.message
        : (typeof placeOrderError === 'object' && placeOrderError !== null && 'message' in placeOrderError && typeof (placeOrderError as { message: unknown }).message === 'string')
          ? (placeOrderError as { message: string }).message
          : 'Failed to place order. Please try again.';
      const lowerMessage = message.toLowerCase();
      const isSessionError = SESSION_KEYWORDS.some((kw) => lowerMessage.includes(kw));
      if (isSessionError && user) {
        navigate('/auth', { state: { from: '/cart' }, replace: true });
      }
      if (!user) {
        setCheckoutStep('payment');
      }
      showToast(message === 'Payment cancelled' ? 'Payment cancelled' : message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleEditConfirm(menuItem: MenuItem, quantity: number, customizations: SelectedCustomization[]) {
    if (!editingItem) return;
    removeItem(editingItem.cartItemId);
    addItem(menuItem, quantity, customizations);
    setEditingItem(null);
    showToast('Item updated!');
  }

  const refreshmentSuggestionState = useMemo(() => {
    const hasSnackTriggerInCart = items.some((item) => {
      const categoryName = offerCategoryNamesById[item.menu_item.category_id] || '';
      return isSnackSuggestionTrigger(item.menu_item, categoryName);
    });

    if (!hasSnackTriggerInCart) {
      return {
        hasSnackTriggerInCart: false,
        localSuggestions: [] as OfferMenuCatalogItem[],
        candidateItems: [] as OfferMenuCatalogItem[],
        cartItemsForAi: [] as Array<{
          menu_item_id: string;
          name: string;
          category_name: string;
          quantity: number;
        }>,
      };
    }

    const cartItemIds = new Set(items.map((item) => item.menu_item.id));
    const waterSuggestions: OfferMenuCatalogItem[] = [];
    const coolDrinkSuggestions: OfferMenuCatalogItem[] = [];
    let hasWaterBottleInCart = false;
    let hasCoolDrinkInCart = false;

    for (const menuItem of Object.values(offerMenuItemsById)) {
      const categoryName = offerCategoryNamesById[menuItem.category_id] || '';
      const waterLike = isWaterBottleLike(menuItem, categoryName);
      const coolDrinkLike = isCoolDrinkLike(menuItem, categoryName);

      if (!waterLike && !coolDrinkLike) {
        continue;
      }

      if (cartItemIds.has(menuItem.id)) {
        hasWaterBottleInCart = hasWaterBottleInCart || waterLike;
        hasCoolDrinkInCart = hasCoolDrinkInCart || coolDrinkLike;
        continue;
      }

      if (waterLike) {
        waterSuggestions.push(menuItem);
        continue;
      }

      coolDrinkSuggestions.push(menuItem);
    }

    waterSuggestions.sort((left, right) => left.price - right.price || left.name.localeCompare(right.name));
    coolDrinkSuggestions.sort((left, right) => left.price - right.price || left.name.localeCompare(right.name));

    return {
      hasSnackTriggerInCart: true,
      localSuggestions: [
        ...(hasWaterBottleInCart ? [] : waterSuggestions.slice(0, 2)),
        ...(hasCoolDrinkInCart ? [] : coolDrinkSuggestions.slice(0, 3)),
      ].slice(0, 4),
      candidateItems: [
        ...(hasWaterBottleInCart ? [] : waterSuggestions),
        ...(hasCoolDrinkInCart ? [] : coolDrinkSuggestions),
      ],
      cartItemsForAi: items.map((item) => ({
        menu_item_id: item.menu_item.id,
        name: item.menu_item.name,
        category_name: offerCategoryNamesById[item.menu_item.category_id] || '',
        quantity: item.quantity,
      })),
    };
  }, [items, offerCategoryNamesById, offerMenuItemsById]);

  useEffect(() => {
    let cancelled = false;
    setAiRefreshmentSuggestions(null);
    const timeoutId = window.setTimeout(() => {
      void loadAiRefreshmentSuggestions();
    }, AI_SUGGESTION_DEBOUNCE_MS);

    async function loadAiRefreshmentSuggestions() {
      if (!refreshmentSuggestionState.hasSnackTriggerInCart || refreshmentSuggestionState.candidateItems.length === 0) {
        setAiRefreshmentSuggestions([]);
        return;
      }

      try {
        const suggestions = await suggestCartAddOns({
          cartItems: refreshmentSuggestionState.cartItemsForAi,
          candidateItems: refreshmentSuggestionState.candidateItems.map((item) => ({
            menu_item_id: item.id,
            name: item.name,
            category_name: offerCategoryNamesById[item.category_id] || '',
            price: item.price,
          })),
          limit: 4,
        });

        if (cancelled) {
          return;
        }

        const candidateItemsById = refreshmentSuggestionState.candidateItems.reduce<Record<string, OfferMenuCatalogItem>>((acc, item) => {
          acc[item.id] = item;
          return acc;
        }, {});

        const nextSuggestions = suggestions
          .map((suggestion) => {
            const menuItem = candidateItemsById[suggestion.menu_item_id];
            if (!menuItem) {
              return null;
            }

            return {
              menuItem,
              reason: suggestion.reason?.trim() || null,
            } satisfies RefreshmentSuggestion;
          })
          .filter((suggestion): suggestion is RefreshmentSuggestion => suggestion !== null);

        setAiRefreshmentSuggestions(nextSuggestions);
      } catch (error) {
        console.error('Failed to load AI cart suggestions', error);
        if (!cancelled) {
          setAiRefreshmentSuggestions(null);
        }
      }
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [offerCategoryNamesById, refreshmentSuggestionState]);

  const refreshmentSuggestions = useMemo(() => {
    if (aiRefreshmentSuggestions !== null) {
      return aiRefreshmentSuggestions;
    }

    return refreshmentSuggestionState.localSuggestions.map((menuItem) => ({
      menuItem,
      reason: null,
    }));
  }, [aiRefreshmentSuggestions, refreshmentSuggestionState.localSuggestions]);

  const handleSuggestedAdd = useCallback((menuItem: MenuItem) => {
    if (!menuItem.is_available) {
      showToast(`${menuItem.name} is currently out of stock`, 'error');
      return;
    }

    const supportsCustomizations = itemHasAssignedCustomizations(menuItem, customizationAvailability);

    // If item already exists in cart without customizations, increment it instead of duplicating
    const existingItem = items.find(
      (i) => i.menu_item.id === menuItem.id && i.customizations.length === 0
    );
    if (existingItem && !supportsCustomizations) {
      updateQuantity(existingItem.id, existingItem.quantity + 1);
      showToast(`${menuItem.name} quantity updated`);
      return;
    }

    const cartItemId = addItem(menuItem, 1, []);
    showToast(`${menuItem.name} added to cart`);

    if (!supportsCustomizations) {
      return;
    }

    setPendingSuggestedItem({ cartItemId, menuItem, quantity: 1 });
  }, [addItem, updateQuantity, items, customizationAvailability, showToast]);

  if (items.length === 0) {
    if (activeCheckoutOrderId) {
      return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center section-padding bg-brand-bg">
          <div className="w-24 h-24 bg-brand-surface rounded-full flex items-center justify-center mb-6">
            <ShoppingBag size={40} className="text-brand-gold" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Redirecting to your order...</h2>
          <p className="text-brand-text-muted text-[15px]">We are opening your order confirmation page.</p>
        </div>
      );
    }

    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center section-padding bg-brand-bg">
        <div className="w-24 h-24 bg-brand-surface rounded-full flex items-center justify-center mb-6">
          <ShoppingBag size={40} className="text-brand-text-dim" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Your cart is empty</h2>
        <p className="text-brand-text-muted text-[15px]">Add some delicious waffles to get started</p>
        <Link to="/menu" className="btn-primary mt-6">Browse Menu</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-bg">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-lg mx-auto px-4 py-6 pb-32"
      >
        <div className="flex items-center justify-between mb-5">
          <Link to="/menu" className="inline-flex items-center gap-2 text-[13px] text-brand-text-dim hover:text-brand-gold transition-colors">
            <ArrowLeft size={15} />
            Menu
          </Link>
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold bg-brand-gold/10 text-brand-gold border border-brand-gold/20">
            <Store size={12} strokeWidth={2.5} />
            Pickup Order
          </div>
        </div>

        <h1 className="text-xl font-extrabold tracking-tight text-white mb-5">
          Cart <span className="text-brand-text-dim font-semibold text-base tabular-nums">({itemCount})</span>
        </h1>

        <div className="space-y-2.5 mb-6">
          <AnimatePresence initial={false}>
          {items.map((item) => {
            const supportsCustomizations = customizationAvailability
              ? itemHasAssignedCustomizations(item.menu_item, customizationAvailability)
              : menuItemSupportsCustomizations(item.menu_item);

            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -60, height: 0, marginBottom: 0, transition: { duration: 0.25, ease: 'easeIn' } }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="bg-brand-surface rounded-xl p-3.5 border border-brand-border flex gap-3"
              >
                <img
                  src={item.menu_item.image_url}
                  alt={item.menu_item.name}
                  loading="lazy"
                  width={64}
                  height={64}
                  className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-white text-[14px] leading-snug">{item.menu_item.name}</h3>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="p-1 hover:bg-red-500/10 rounded-lg text-brand-text-dim hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <Trash2 size={14} strokeWidth={2.2} />
                    </button>
                  </div>

                  {item.customizations.length > 0 && (
                    <div className="mt-1 flex items-start gap-1.5">
                      <div className="flex-1 min-w-0">
                        <CartCustomizations customizations={item.customizations} />
                      </div>
                      {supportsCustomizations && (
                        <button
                          onClick={() => setEditingItem({
                            cartItemId: item.id,
                            menuItem: item.menu_item,
                            quantity: item.quantity,
                            customizations: item.customizations,
                          })}
                          className="flex items-center gap-1 text-[11px] font-bold text-brand-gold hover:text-brand-gold-soft transition-colors flex-shrink-0 mt-0.5"
                        >
                          <Pencil size={10} />
                          Edit
                        </button>
                      )}
                    </div>
                  )}

                  {item.customizations.length === 0 && supportsCustomizations && (
                    <button
                    onClick={() => setEditingItem({
                      cartItemId: item.id,
                      menuItem: item.menu_item,
                      quantity: item.quantity,
                      customizations: item.customizations,
                    })}
                      className="flex items-center gap-1 text-[11px] font-bold text-brand-gold hover:text-brand-gold-soft transition-colors mt-1"
                    >
                      <Plus size={10} />
                      Add toppings
                    </button>
                  )}

                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center border border-brand-gold/30 rounded-lg overflow-hidden">
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        className="w-7 h-7 flex items-center justify-center text-brand-gold hover:bg-brand-gold/10 transition-colors"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="w-6 text-center text-[12px] font-bold tabular-nums text-brand-gold">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        className="w-7 h-7 flex items-center justify-center text-brand-gold hover:bg-brand-gold/10 transition-colors"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                    <span className="font-bold text-brand-gold tabular-nums text-[14px]">{'\u20B9'}{item.total_price.toFixed(0)}</span>
                  </div>
                </div>
              </motion.div>
            );
          })}
          </AnimatePresence>

          {promoRewardItems.length > 0 && (
            <div className="space-y-2">
              {promoRewardItems.map((item) => (
                <div
                  key={`${item.offer_id}-${item.menu_item_id}`}
                  className="flex gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5"
                >
                  <img
                    src={item.image_url}
                    alt={item.item_name}
                    loading="lazy"
                    width={64}
                    height={64}
                    className="h-16 w-16 flex-shrink-0 rounded-lg object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-[14px] font-bold leading-snug text-white">{item.item_name}</h3>
                        <p className="mt-0.5 text-[11px] font-medium text-emerald-300">
                          Free with {item.offer_title}
                        </p>
                      </div>
                      <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                        Free
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[12px] font-bold text-emerald-300">{item.quantity}x added automatically</span>
                      <span className="text-[14px] font-bold tabular-nums text-emerald-300">₹0</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {refreshmentSuggestions.length > 0 && (
            <div className="rounded-2xl border border-brand-gold/20 bg-brand-gold/[0.04] p-4">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.24em] text-brand-gold">Complete Your Order</p>
                <h2 className="mt-1 text-[16px] font-extrabold tracking-tight text-white">
                  Add drinks with your snacks
                </h2>
                <p className="mt-1 text-[12px] font-medium text-brand-text-dim">
                  Quick water bottle and cool drink picks before checkout.
                </p>
              </div>

              <div className="mt-3 space-y-2.5">
                {refreshmentSuggestions.map((suggestion) => {
                  const menuItem = suggestion.menuItem;
                  const categoryName = offerCategoryNamesById[menuItem.category_id] || '';

                  return (
                    <div
                      key={menuItem.id}
                      className="flex items-center gap-3 rounded-xl border border-brand-border bg-brand-surface p-2.5"
                    >
                      <img
                        src={menuItem.image_url || '/image.png'}
                        alt={menuItem.name}
                        loading="lazy"
                        width={56}
                        height={56}
                        className="h-14 w-14 flex-shrink-0 rounded-lg object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-bold text-white">{menuItem.name}</p>
                        <p className="mt-0.5 text-[11px] font-medium text-brand-text-dim">
                          {suggestion.reason || getRefreshmentSuggestionLabel(menuItem, categoryName)}
                        </p>
                        <p className="mt-1 text-[13px] font-extrabold text-brand-gold">
                          {'\u20B9'}{menuItem.price}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSuggestedAdd(menuItem)}
                        className="rounded-lg border-2 border-brand-gold px-3 py-2 text-[11px] font-black text-brand-gold transition-colors hover:bg-brand-gold hover:text-brand-bg"
                      >
                        ADD
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <Link
            to="/menu"
            className="flex items-center justify-center gap-1.5 py-2.5 text-[13px] font-bold text-brand-gold hover:bg-brand-gold/5 rounded-xl transition-colors"
          >
            <Plus size={14} strokeWidth={2.5} />
            Add more items
          </Link>
        </div>


        <div className="bg-brand-surface rounded-xl p-4 border border-brand-border mb-6">
          <div className="space-y-2 text-[14px]">
            <div className="flex justify-between text-brand-text-muted">
              <span className="text-[13px]">Subtotal</span>
              <span className="tabular-nums">{'\u20B9'}{subtotal.toFixed(0)}</span>
            </div>
            {couponDiscount > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span className="text-[13px]">Coupon</span>
                <span className="tabular-nums">-{'\u20B9'}{couponDiscount.toFixed(0)}</span>
              </div>
            )}
            {automaticDiscount > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span className="text-[13px]">Offer</span>
                <span className="tabular-nums">-{'\u20B9'}{automaticDiscount.toFixed(0)}</span>
              </div>
            )}
            {reviewRewardDiscount > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span className="text-[13px]">Review reward</span>
                <span className="tabular-nums">-{'\u20B9'}{reviewRewardDiscount.toFixed(0)}</span>
              </div>
            )}
            {promoRewardItems.length > 0 && (
              <div className="flex justify-between text-emerald-300">
                <span className="text-[13px]">Free items added</span>
                <span className="tabular-nums">{promoRewardItems.reduce((sum, item) => sum + item.quantity, 0)}</span>
              </div>
            )}
            {addOnTotal > 0 && (
              <div className="flex justify-between text-brand-text-muted">
                <span className="text-[13px]">Add-ons in cart</span>
                <span className="tabular-nums">{'\u20B9'}{addOnTotal.toFixed(0)}</span>
              </div>
            )}
            {discount > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span className="text-[13px]">Total savings</span>
                <span className="tabular-nums">-{'\u20B9'}{discount.toFixed(0)}</span>
              </div>
            )}
            {deliveryFee > 0 && (
              <div className="flex justify-between text-brand-text-muted">
                <span className="text-[13px]">Delivery fee</span>
                <span className="tabular-nums">{'\u20B9'}{deliveryFee.toFixed(0)}</span>
              </div>
            )}
            {takeawayFee > 0 && (
              <div className="flex justify-between text-brand-text-muted">
                <span className="text-[13px]">Takeaway charge</span>
                <span className="tabular-nums">{'\u20B9'}{takeawayFee.toFixed(0)}</span>
              </div>
            )}
            <div className="border-t border-brand-border pt-2.5 flex justify-between font-bold">
              <span className="text-white">Total</span>
              <span className="tabular-nums text-lg tracking-tight text-brand-gold">{'\u20B9'}{total.toFixed(0)}</span>
            </div>
          </div>
        </div>

        <div className="cart-submit-bar">
          <div className="max-w-lg mx-auto">
            <motion.button
              onClick={handleCheckoutStart}
              disabled={submitting || !!(settings && !settings.site_is_open)}
              whileTap={{ scale: 0.97 }}
              animate={submitting ? { boxShadow: ['0 0 0 0 rgba(216,178,78,0)', '0 0 16px 4px rgba(216,178,78,0.2)', '0 0 0 0 rgba(216,178,78,0)'] } : {}}
              transition={submitting ? { duration: 1.2, repeat: Infinity } : { duration: 0.1 }}
              className="btn-primary w-full text-center text-[15px] font-extrabold py-3.5 rounded-xl tracking-tight"
            >
              {settings && !settings.site_is_open
                ? settings.reopening_text || 'Orders Closed'
                : submitting
                ? paymentMethod === 'card' && !isFreeOrder ? 'Opening Payment...' : 'Placing Order...'
                : 'Proceed to Pay'}
            </motion.button>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {checkoutStep && (
          <CheckoutFlowModal
            step={checkoutStep}
            isSignedIn={!!user}
            name={name}
            email={email}
            phone={phone}
            orderType={activeOrderType}
            pickupOption={pickupOption}
            address={deliveryAddress}
            pincode={deliveryPincode}
            deliveryZone={deliveryZone}
            deliveryFee={deliveryFee}
            deliveryMinimumOrder={deliveryMinimumOrder}
            deliveryEstimatedTime={deliveryEstimatedTime}
            deliveryLookupLoading={deliveryLookupLoading}
            deliveryLookupError={deliveryLookupError}
            subtotal={subtotal}
            couponDiscount={couponDiscount}
            automaticDiscount={automaticDiscount}
            reviewRewardDiscount={reviewRewardDiscount}
            discount={discount}
            addOnTotal={addOnTotal}
            rewardItemCount={promoRewardItems.reduce((sum, item) => sum + item.quantity, 0)}
            takeawayFee={takeawayFee}
            paymentMethod={paymentMethod}
            total={total}
            isFreeOrder={isFreeOrder}
            submitting={submitting}
            couponCode={couponCode}
            appliedOffer={appliedOffer}
            couponError={couponError}
            couponRewardItems={couponRewardItems}
            automaticRewardItems={automaticRewardItems}
            reviewRewardCoupons={reviewRewardCoupons}
            selectedReviewRewardCouponId={selectedReviewRewardCouponId}
            applicableAutomaticOffers={applicableAutomaticOffers}
            selectedAutomaticOfferId={selectedAutomaticOfferId}
            featuredAutomaticOffer={featuredAutomaticOffer}
            automaticOfferApplied={automaticOfferApplied}
            multipleAutomaticOffersAvailable={multipleAutomaticOffersAvailable}
            onClose={closeCheckoutFlow}
            onBack={() => {
              if (checkoutStep === 'coupon') setCheckoutStep('service');
              else if (checkoutStep === 'payment') setCheckoutStep('coupon');
            }}
            onNameChange={setName}
            onEmailChange={setEmail}
            onPhoneChange={setPhone}
            onSelectOrderType={handleOrderTypeChoice}
            onSelectPickupOption={handlePickupChoice}
            onAddressChange={setDeliveryAddress}
            onPincodeChange={setDeliveryPincode}
            onCouponCodeChange={(v) => setCouponCode(v.toUpperCase())}
            onApplyCoupon={applyCoupon}
            onRemoveCoupon={() => { setAppliedOffer(null); setCouponCode(''); }}
            onSelectReviewRewardCoupon={setSelectedReviewRewardCouponId}
            onSelectAutomaticOffer={setSelectedAutomaticOfferId}
            onContinueService={handleServiceContinue}
            onContinueCoupon={handleCouponContinue}
            onSelectPaymentMethod={handlePaymentChoice}
            onContinuePayment={handlePaymentContinue}
            onLatChange={setDeliveryLat}
            onLngChange={setDeliveryLng}
            onExtendedConfirm={(data: MapConfirmData) => {
              setDeliveryHouseNumber(data.houseNumber);
              setDeliveryBuildingName(data.buildingName);
              setDeliveryFloorNumber(data.floorNumber);
              setDeliveryLandmark(data.landmark);
              setDeliveryInstructions(data.deliveryInstructions);
              setDetectedGpsLat(data.detectedGpsLat);
              setDetectedGpsLng(data.detectedGpsLng);
              setAddressConfidence(data.confidenceScore);
              setSavedAddressId(data.savedAddressId);
            }}
          />
        )}
      </AnimatePresence>

      {editingItem && (
        <CustomizationModal
          item={editingItem.menuItem}
          initialQuantity={editingItem.quantity}
          initialCustomizations={editingItem.customizations}
          onClose={() => setEditingItem(null)}
          onConfirm={handleEditConfirm}
        />
      )}
      {pendingSuggestedItem && (
        <CustomizationModal
          item={pendingSuggestedItem.menuItem}
          initialQuantity={pendingSuggestedItem.quantity}
          onClose={() => setPendingSuggestedItem(null)}
          onConfirm={(menuItem, quantity, customizations) => {
            removeItem(pendingSuggestedItem.cartItemId);
            addItem(menuItem, quantity, customizations);
            setPendingSuggestedItem(null);
            showToast(`${menuItem.name} add-ons updated`);
          }}
        />
      )}
    </div>
  );
}

function CheckoutFlowModal({
  step,
  isSignedIn,
  name,
  email,
  phone,
  orderType,
  pickupOption,
  address,
  pincode,
  deliveryZone,
  deliveryFee,
  deliveryMinimumOrder,
  deliveryEstimatedTime,
  deliveryLookupLoading,
  deliveryLookupError,
  subtotal,
  couponDiscount,
  automaticDiscount,
  reviewRewardDiscount,
  discount,
  addOnTotal,
  rewardItemCount,
  takeawayFee,
  paymentMethod,
  total,
  isFreeOrder,
  submitting,
  couponCode,
  appliedOffer,
  couponError,
  couponRewardItems,
  automaticRewardItems,
  reviewRewardCoupons,
  selectedReviewRewardCouponId,
  applicableAutomaticOffers,
  selectedAutomaticOfferId,
  featuredAutomaticOffer,
  automaticOfferApplied,
  multipleAutomaticOffersAvailable,
  onClose,
  onBack,
  onNameChange,
  onEmailChange,
  onPhoneChange,
  onSelectOrderType,
  onSelectPickupOption,
  onAddressChange,
  onPincodeChange,
  onCouponCodeChange,
  onApplyCoupon,
  onRemoveCoupon,
  onSelectReviewRewardCoupon,
  onSelectAutomaticOffer,
  onContinueService,
  onContinueCoupon,
  onSelectPaymentMethod,
  onContinuePayment,
  onLatChange,
  onLngChange,
  onExtendedConfirm,
}: {
  step: CheckoutStep;
  isSignedIn: boolean;
  name: string;
  email: string;
  phone: string;
  orderType: CheckoutOrderType;
  pickupOption: PickupOption;
  address: string;
  pincode: string;
  deliveryZone: DeliveryZone | null;
  deliveryFee: number;
  deliveryMinimumOrder: number;
  deliveryEstimatedTime: number;
  deliveryLookupLoading: boolean;
  deliveryLookupError: string;
  subtotal: number;
  couponDiscount: number;
  automaticDiscount: number;
  reviewRewardDiscount: number;
  discount: number;
  addOnTotal: number;
  rewardItemCount: number;
  takeawayFee: number;
  paymentMethod: PaymentMethod;
  total: number;
  isFreeOrder: boolean;
  submitting: boolean;
  couponCode: string;
  appliedOffer: Offer | null;
  couponError: string;
  couponRewardItems: OfferRewardItem[];
  automaticRewardItems: OfferRewardItem[];
  reviewRewardCoupons: ReviewRewardCoupon[];
  selectedReviewRewardCouponId: string | null;
  applicableAutomaticOffers: Array<{ offer: Offer; discountAmount: number; freeItems: OfferRewardItem[] }>;
  selectedAutomaticOfferId: string | null;
  featuredAutomaticOffer: Offer | null;
  automaticOfferApplied: boolean;
  multipleAutomaticOffersAvailable: boolean;
  onClose: () => void;
  onBack: () => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onSelectOrderType: (value: CheckoutOrderType) => void;
  onSelectPickupOption: (option: PickupOption) => void;
  onAddressChange: (value: string) => void;
  onPincodeChange: (value: string) => void;
  onCouponCodeChange: (value: string) => void;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  onSelectReviewRewardCoupon: (id: string | null) => void;
  onSelectAutomaticOffer: (id: string | null) => void;
  onContinueService: () => void;
  onContinueCoupon: () => void;
  onSelectPaymentMethod: (method: PaymentMethod) => void;
  onContinuePayment: () => void;
  onLatChange: (lat: number | null) => void;
  onLngChange: (lng: number | null) => void;
  onExtendedConfirm: (data: MapConfirmData) => void;
}) {
  const isDelivery = orderType === 'delivery';
  const stepNumber = step === 'service' ? 1 : step === 'coupon' ? 2 : 3;
  const heading = step === 'service'
    ? 'How would you like it?'
    : step === 'coupon'
      ? 'Save on your order'
      : isFreeOrder ? 'Place order' : 'Payment';
  const cashLabel = isDelivery ? 'Cash on Delivery' : 'Pay at Counter';
  const cashDescription = isDelivery ? 'Pay when your order arrives' : 'Pay when you collect';

  const serviceModeSummary = isDelivery
    ? deliveryZone
      ? `Delivery · ${deliveryZone.area_name}${deliveryFee > 0 ? ` · ₹${deliveryFee.toFixed(0)} fee` : ' · Free delivery'}${deliveryEstimatedTime > 0 ? ` · ~${deliveryEstimatedTime} min` : ''}`
      : deliveryLookupLoading
        ? 'Delivery · Checking availability…'
        : 'Delivery'
    : pickupOption === 'takeaway'
      ? `Takeaway · +₹${TAKEAWAY_CHARGE} charge`
      : 'Dine In · No extra charge';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 sm:items-center sm:px-4 sm:py-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl border-t border-brand-border bg-brand-bg p-5 shadow-elevated sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {(step === 'coupon' || step === 'payment') && (
                <button
                  onClick={onBack}
                  disabled={submitting}
                  className="flex items-center gap-1 text-[13px] font-bold text-brand-gold hover:text-brand-gold/80 disabled:opacity-60 transition-colors"
                >
                  <ArrowLeft size={14} strokeWidth={2.5} />
                  Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-gold text-[11px] font-black text-brand-bg">{stepNumber}</span>
              <span className="text-[11px] font-bold text-brand-text-dim uppercase tracking-wider">Step {stepNumber} of 3</span>
            </div>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight text-white">{heading}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-brand-border px-3 py-1.5 text-[12px] font-bold text-brand-text-muted transition-colors hover:border-red-500/30 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Close
          </button>
        </div>

        {/* ── Step 1: Service Mode ── */}
        {step === 'service' && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {([
                { type: 'pickup' as CheckoutOrderType, pickup: 'dine_in' as PickupOption, icon: Store, label: 'Dine In', sub: 'No extra charge' },
                { type: 'pickup' as CheckoutOrderType, pickup: 'takeaway' as PickupOption, icon: ShoppingBag, label: 'Takeaway', sub: `+₹${TAKEAWAY_CHARGE}` },
                { type: 'delivery' as CheckoutOrderType, pickup: 'takeaway' as PickupOption, icon: MapPin, label: 'Delivery', sub: 'Online only' },
              ] as const).map(({ type, pickup, icon: Icon, label, sub }) => {
                const isActive = type === 'delivery'
                  ? isDelivery
                  : !isDelivery && pickupOption === pickup;
                return (
                  <button
                    key={label}
                    onClick={() => {
                      if (type === 'delivery') {
                        onSelectOrderType('delivery');
                      } else {
                        onSelectOrderType('pickup');
                        onSelectPickupOption(pickup);
                      }
                    }}
                    disabled={submitting}
                    className={`flex flex-col items-center gap-2 rounded-2xl border-2 px-2 py-4 transition-all disabled:opacity-60 ${
                      isActive
                        ? 'border-brand-gold bg-brand-gold/10'
                        : 'border-brand-border hover:border-brand-gold/40'
                    }`}
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${isActive ? 'bg-brand-gold/20' : 'bg-brand-surface-light'}`}>
                      <Icon size={20} className={isActive ? 'text-brand-gold' : 'text-brand-text-dim'} strokeWidth={2} />
                    </div>
                    <span className={`text-[13px] font-black ${isActive ? 'text-white' : 'text-brand-text-muted'}`}>{label}</span>
                    <span className={`text-[10px] font-semibold ${isActive ? 'text-brand-gold' : 'text-brand-text-dim'}`}>{sub}</span>
                  </button>
                );
              })}
            </div>

            {isDelivery && (
              <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="relative">
                    <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-text-dim" />
                    <input
                      type="text"
                      placeholder="Your name *"
                      value={name}
                      onChange={(e) => onNameChange(e.target.value)}
                      className="input-field pl-9 text-[14px]"
                      autoComplete="name"
                    />
                  </div>
                  <div className="relative">
                    <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-text-dim" />
                    <input
                      type="tel"
                      inputMode="numeric"
                      placeholder="Mobile number *"
                      value={phone}
                      onChange={(e) => onPhoneChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      className="input-field pl-9 text-[14px]"
                      autoComplete="tel"
                    />
                  </div>
                </div>
                <LocationPicker
                  address={address}
                  pincode={pincode}
                  onAddressChange={onAddressChange}
                  onPincodeChange={onPincodeChange}
                  onLatChange={onLatChange}
                  onLngChange={onLngChange}
                  onExtendedConfirm={onExtendedConfirm}
                />
                {deliveryLookupLoading && (
                  <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-2.5 text-[12px] font-semibold text-sky-400">
                    Checking delivery availability…
                  </div>
                )}
                {!deliveryLookupLoading && deliveryZone && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5">
                    <p className="text-[13px] font-bold text-emerald-400">{deliveryZone.area_name}</p>
                    <p className="mt-0.5 text-[11px] text-emerald-300">
                      {deliveryFee === 0 ? 'Free delivery' : `Fee ₹${deliveryFee.toFixed(0)}`}
                      {deliveryEstimatedTime > 0 ? ` · ~${deliveryEstimatedTime} min` : ''}
                      {deliveryMinimumOrder > 0 ? ` · Min ₹${deliveryMinimumOrder}` : ''}
                    </p>
                  </div>
                )}
                {!deliveryLookupLoading && !deliveryZone && deliveryLookupError && pincode.trim().length === 6 && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-[12px] font-semibold text-red-300">
                    {deliveryLookupError}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={onContinueService}
              disabled={submitting}
              className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── Step 2: Coupon ── */}
        {step === 'coupon' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-surface px-3 py-2.5 text-[12px]">
              {isDelivery ? <MapPin size={13} className="text-brand-gold flex-shrink-0" /> : pickupOption === 'takeaway' ? <ShoppingBag size={13} className="text-brand-gold flex-shrink-0" /> : <Store size={13} className="text-brand-gold flex-shrink-0" />}
              <span className="font-semibold text-brand-text-muted">{serviceModeSummary}</span>
            </div>

            <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 space-y-3">
              <p className="text-[13px] font-bold text-white flex items-center gap-2">
                <Tag size={14} className="text-brand-gold" />
                Have a coupon code?
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter code"
                  value={couponCode}
                  onChange={(e) => onCouponCodeChange(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && onApplyCoupon()}
                  className="input-field flex-1 text-[14px] font-semibold tracking-wider"
                />
                <button
                  onClick={onApplyCoupon}
                  className="btn-outline px-4 py-2 text-[13px] font-bold rounded-lg"
                >
                  Apply
                </button>
              </div>
              {couponError && <p className="text-red-400 text-[12px]">{couponError}</p>}
              {appliedOffer && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[12px]">
                  <span className="font-semibold text-emerald-300">
                    {appliedOffer.title} — {couponRewardItems.length > 0 ? `${getPromoRewardSummary(couponRewardItems)} free` : getOfferRuleSummary(appliedOffer)}
                  </span>
                  <button onClick={onRemoveCoupon} className="font-bold text-brand-text-muted hover:text-white flex-shrink-0">Remove</button>
                </div>
              )}
            </div>

            {reviewRewardCoupons.length > 0 && (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Gift size={15} className="text-emerald-300" />
                    <span className="text-[13px] font-bold text-emerald-200">Review rewards</span>
                  </div>
                  {selectedReviewRewardCouponId && (
                    <button onClick={() => onSelectReviewRewardCoupon(null)} className="text-[12px] font-bold text-brand-text-muted hover:text-white">Remove</button>
                  )}
                </div>
                <div className="space-y-2">
                  {reviewRewardCoupons.map((coupon) => {
                    const isSelected = selectedReviewRewardCouponId === coupon.id;
                    const amt = calculateReviewRewardDiscount(subtotal, Number(coupon.discount_percentage || 0));
                    return (
                      <button
                        key={coupon.id}
                        onClick={() => onSelectReviewRewardCoupon(coupon.id)}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${isSelected ? 'border-emerald-400/40 bg-emerald-500/15' : 'border-brand-border bg-brand-surface/40 hover:border-emerald-500/30'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[13px] font-bold ${isSelected ? 'text-emerald-300' : 'text-white'}`}>{coupon.code}</span>
                          <span className={`text-[12px] font-black ${isSelected ? 'text-emerald-200' : 'text-emerald-400'}`}>Save ₹{amt.toFixed(0)}</span>
                        </div>
                        <p className={`mt-0.5 text-[11px] ${isSelected ? 'text-emerald-200' : 'text-brand-text-muted'}`}>10% off from your item review</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {featuredAutomaticOffer && (
              <div className="rounded-2xl border border-brand-gold/20 bg-brand-gold/[0.06] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-brand-gold">
                    {multipleAutomaticOffersAvailable ? 'Choose an offer' : featuredAutomaticOffer.title}
                  </span>
                  {multipleAutomaticOffersAvailable && automaticOfferApplied && (
                    <button onClick={() => onSelectAutomaticOffer(null)} className="text-[12px] font-bold text-brand-text-muted hover:text-white">Change</button>
                  )}
                </div>
                {!multipleAutomaticOffersAvailable && (
                  <p className={`text-[12px] ${automaticOfferApplied ? 'text-emerald-400' : 'text-brand-gold/80'}`}>
                    {automaticOfferApplied
                      ? automaticRewardItems.length > 0
                        ? `${getPromoRewardSummary(automaticRewardItems)} added free`
                        : `You save ₹${automaticDiscount.toFixed(0)}`
                      : getOfferRuleSummary(featuredAutomaticOffer)}
                  </p>
                )}
                {multipleAutomaticOffersAvailable && (
                  <div className="space-y-2">
                    {applicableAutomaticOffers.map((result) => {
                      const isSelected = selectedAutomaticOfferId === result.offer.id;
                      const valueText = result.freeItems.length > 0 ? `${getPromoRewardSummary(result.freeItems)} free` : `Save ₹${result.discountAmount.toFixed(0)}`;
                      return (
                        <button
                          key={result.offer.id}
                          onClick={() => onSelectAutomaticOffer(result.offer.id)}
                          className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${isSelected ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-brand-border bg-brand-surface/40 hover:border-brand-gold/30'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-[13px] font-bold ${isSelected ? 'text-emerald-400' : 'text-white'}`}>{result.offer.title || getOfferBadgeLabel(result.offer)}</span>
                            <span className={`text-[11px] font-black ${isSelected ? 'text-emerald-300' : 'text-brand-gold'}`}>{valueText}</span>
                          </div>
                          <p className={`mt-0.5 text-[11px] ${isSelected ? 'text-emerald-300' : 'text-brand-text-muted'}`}>{getOfferRuleSummary(result.offer)}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {discount > 0 && (
              <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3">
                <span className="text-[13px] font-bold text-emerald-300">Total savings</span>
                <span className="text-[15px] font-black text-emerald-300">-₹{discount.toFixed(0)}</span>
              </div>
            )}

            <button
              onClick={onContinueCoupon}
              disabled={submitting}
              className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              {discount > 0 ? 'Continue with Savings' : 'Continue'}
            </button>
          </div>
        )}

        {/* ── Step 3: Payment ── */}
        {step === 'payment' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-surface px-3 py-2.5 text-[12px]">
              {isDelivery ? <MapPin size={13} className="text-brand-gold flex-shrink-0" /> : pickupOption === 'takeaway' ? <ShoppingBag size={13} className="text-brand-gold flex-shrink-0" /> : <Store size={13} className="text-brand-gold flex-shrink-0" />}
              <span className="font-semibold text-brand-text-muted">{serviceModeSummary}</span>
            </div>

            {!isSignedIn && !isDelivery && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-xl border-2 border-brand-gold bg-brand-gold/10 p-3 text-left">
                  <span className="block text-[14px] font-extrabold text-white">Continue as guest</span>
                  <span className="mt-1 block text-[11px] text-brand-text-muted">Name and email only.</span>
                </div>
                <Link
                  to="/auth"
                  state={{ from: '/cart' }}
                  className="rounded-xl border-2 border-brand-border bg-brand-surface p-3 text-left transition-colors hover:border-brand-gold/40"
                >
                  <span className="block text-[14px] font-extrabold text-white">Sign in</span>
                  <span className="mt-1 block text-[11px] text-brand-text-muted">Faster checkout + rewards.</span>
                </Link>
              </div>
            )}

            {isSignedIn && (
              <div className="flex items-center gap-3 rounded-xl border border-brand-gold/20 bg-brand-gold/5 px-3 py-2.5">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-gold/10">
                  <User size={16} className="text-brand-gold" />
                </div>
                <div>
                  <p className="text-[13px] font-bold text-white">Signed in</p>
                  <p className="text-[11px] text-brand-text-dim">Receipt will go to the email below.</p>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="relative">
                  <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-text-dim" />
                  <input
                    type="text"
                    placeholder="Your name *"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    className="input-field pl-9 text-[14px]"
                    autoComplete="name"
                    autoFocus={!name}
                  />
                </div>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-text-dim" />
                  <input
                    type="email"
                    placeholder="Email for receipt *"
                    value={email}
                    onChange={(e) => onEmailChange(e.target.value)}
                    className="input-field pl-9 text-[14px]"
                    autoComplete="email"
                  />
                </div>
              </div>
              {!isDelivery && (
                <p className="text-[11px] text-brand-text-dim">We will send your order receipt to this email.</p>
              )}
            </div>

            <CheckoutBillSummary
              subtotal={subtotal}
              couponDiscount={couponDiscount}
              automaticDiscount={automaticDiscount}
              reviewRewardDiscount={reviewRewardDiscount}
              discount={discount}
              addOnTotal={addOnTotal}
              rewardItemCount={rewardItemCount}
              deliveryFee={deliveryFee}
              takeawayFee={takeawayFee}
              total={total}
            />

            {isFreeOrder ? (
              <button
                onClick={onContinuePayment}
                disabled={submitting}
                className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Placing Order…' : 'Place Free Order'}
              </button>
            ) : isDelivery ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-xl border border-brand-gold/30 px-4 py-3" style={{ background: 'rgba(216,178,78,0.07)' }}>
                  <CreditCard size={18} className="text-brand-gold flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-bold text-white">Online payment only</p>
                    <p className="text-[11px] text-brand-text-dim">Delivery orders require UPI, card, or net banking.</p>
                  </div>
                </div>
                <button
                  onClick={onContinuePayment}
                  disabled={submitting}
                  className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Opening Payment…' : `Pay ₹${total.toFixed(0)} Online`}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    onClick={() => onSelectPaymentMethod('card')}
                    disabled={submitting}
                    className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 px-3 py-4 text-center transition-all disabled:opacity-60 ${
                      paymentMethod === 'card' ? 'border-brand-gold bg-brand-gold/10' : 'border-brand-border bg-brand-surface hover:border-brand-gold/40'
                    }`}
                  >
                    <CreditCard size={22} className={paymentMethod === 'card' ? 'text-brand-gold' : 'text-brand-text-dim'} />
                    <span className={`text-[13px] font-bold ${paymentMethod === 'card' ? 'text-white' : 'text-brand-text-muted'}`}>Pay Online</span>
                    <span className="text-[11px] text-brand-text-dim">UPI, cards & more</span>
                  </button>
                  <button
                    onClick={() => onSelectPaymentMethod('cod')}
                    disabled={submitting}
                    className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 px-3 py-4 text-center transition-all disabled:opacity-60 ${
                      paymentMethod === 'cod' ? 'border-brand-gold bg-brand-gold/10' : 'border-brand-border bg-brand-surface hover:border-brand-gold/40'
                    }`}
                  >
                    <Wallet size={22} className={paymentMethod === 'cod' ? 'text-brand-gold' : 'text-brand-text-dim'} />
                    <span className={`text-[13px] font-bold ${paymentMethod === 'cod' ? 'text-white' : 'text-brand-text-muted'}`}>{cashLabel}</span>
                    <span className="text-[11px] text-brand-text-dim">{cashDescription}</span>
                  </button>
                </div>
                <button
                  onClick={onContinuePayment}
                  disabled={submitting}
                  className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting
                    ? paymentMethod === 'card' ? 'Opening Payment…' : 'Placing Order…'
                    : paymentMethod === 'card'
                      ? `Pay ₹${total.toFixed(0)} Online`
                      : 'Place Order'}
                </button>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function CheckoutBillSummary({
  subtotal,
  couponDiscount,
  automaticDiscount,
  reviewRewardDiscount,
  discount,
  addOnTotal,
  rewardItemCount,
  deliveryFee,
  takeawayFee,
  total,
}: {
  subtotal: number;
  couponDiscount: number;
  automaticDiscount: number;
  reviewRewardDiscount: number;
  discount: number;
  addOnTotal: number;
  rewardItemCount: number;
  deliveryFee: number;
  takeawayFee: number;
  total: number;
}) {
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] font-black text-white">Bill details</span>
        {discount > 0 && (
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-black text-emerald-400">
            Saved ₹{discount.toFixed(0)}
          </span>
        )}
      </div>
      <div className="space-y-2 text-[13px]">
        <div className="flex justify-between gap-3 text-brand-text-muted">
          <span>Item total</span>
          <span className="tabular-nums">₹{subtotal.toFixed(0)}</span>
        </div>
        {couponDiscount > 0 && (
          <div className="flex justify-between gap-3 text-emerald-400">
            <span>Coupon discount</span>
            <span className="tabular-nums">-₹{couponDiscount.toFixed(0)}</span>
          </div>
        )}
        {automaticDiscount > 0 && (
          <div className="flex justify-between gap-3 text-emerald-400">
            <span>Offer discount</span>
            <span className="tabular-nums">-₹{automaticDiscount.toFixed(0)}</span>
          </div>
        )}
        {reviewRewardDiscount > 0 && (
          <div className="flex justify-between gap-3 text-emerald-400">
            <span>Review reward</span>
            <span className="tabular-nums">-₹{reviewRewardDiscount.toFixed(0)}</span>
          </div>
        )}
        {rewardItemCount > 0 && (
          <div className="flex justify-between gap-3 text-emerald-300">
            <span>Free items</span>
            <span className="tabular-nums">{rewardItemCount}</span>
          </div>
        )}
        {addOnTotal > 0 && (
          <div className="flex justify-between gap-3 text-brand-text-muted">
            <span>Add-ons</span>
            <span className="tabular-nums">₹{addOnTotal.toFixed(0)}</span>
          </div>
        )}
        {deliveryFee > 0 && (
          <div className="flex justify-between gap-3 text-brand-text-muted">
            <span>Delivery fee</span>
            <span className="tabular-nums">₹{deliveryFee.toFixed(0)}</span>
          </div>
        )}
        {takeawayFee > 0 && (
          <div className="flex justify-between gap-3 text-brand-text-muted">
            <span>Takeaway charge</span>
            <span className="tabular-nums">₹{takeawayFee.toFixed(0)}</span>
          </div>
        )}
        <div className="border-t border-brand-border pt-2.5">
          <div className="flex justify-between gap-3">
            <span className="font-black text-white">To pay</span>
            <span className="tabular-nums text-lg font-black text-brand-gold">₹{total.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CartCustomizations({ customizations }: { customizations: SelectedCustomization[] }) {
  const grouped: Record<string, string[]> = {};
  for (const c of customizations) {
    if (!grouped[c.group_name]) grouped[c.group_name] = [];
    grouped[c.group_name].push(c.option_name);
  }

  return (
    <div className="space-y-0.5">
      {Object.entries(grouped).map(([group, options]) => (
        <p key={group} className="text-[11px] text-brand-text-dim leading-snug truncate">
          <span className="text-brand-text-muted">{group}:</span> {options.join(', ')}
        </p>
      ))}
    </div>
  );
}
