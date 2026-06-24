export interface Category {
  id: string;
  name: string;
  slug: string;
  image_url: string;
  display_order: number;
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price: number;
  image_url: string;
  prep_time: number;
  rating: number;
  is_veg: boolean;
  is_non_veg?: boolean;
  is_eggless: boolean;
  is_available: boolean;
  manual_availability?: boolean;
  track_inventory?: boolean;
  available_quantity?: number;
  has_customizations?: boolean;
  display_order: number;
}

export interface CustomizationGroup {
  id: string;
  name: string;
  selection_type: 'single' | 'multi';
  is_required: boolean;
  display_order: number;
}

export interface CustomizationOption {
  id: string;
  group_id: string;
  name: string;
  price: number;
  created_at?: string;
  preview_image_url: string;
  preview_image_source?: 'item' | 'category' | 'default' | null;
  is_available: boolean;
  display_order: number;
}

export interface CustomizationGroupTarget {
  id: string;
  group_id: string;
  category_id: string | null;
  menu_item_id: string | null;
}

export interface CustomizationOptionPreviewOverride {
  id: string;
  group_id: string;
  option_name: string;
  category_id: string | null;
  menu_item_id: string | null;
  preview_image_url: string;
}

export interface DeliveryZone {
  id: string;
  pincode: string;
  area_name: string;
  delivery_fee: number;
  min_order: number;
  estimated_time: number;
  is_active: boolean;
}

export interface SiteSettings {
  id: boolean;
  site_is_open: boolean;
  closure_title: string;
  closure_message: string;
  reopening_text: string;
  rain_enabled: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_from_email: string;
  smtp_from_name: string;
  created_at: string;
  updated_at: string;
}

export type OfferMode = 'coupon' | 'automatic';
export type OfferTriggerType = 'min_order' | 'item_quantity';
export type OfferDiscountType = 'percentage' | 'flat' | 'free_addons' | 'free_item';
export type OfferCtaTargetType = 'menu' | 'category' | 'item';
export type OfferRewardItemSource = 'specific_item' | 'qualifying_item';

export interface Offer {
  id: string;
  title: string | null;
  description: string;
  code: string | null;
  display_badge?: string | null;
  display_reward?: string | null;
  background_image_url?: string | null;
  cta_text?: string | null;
  cta_target_type?: OfferCtaTargetType | null;
  cta_target_category_id?: string | null;
  cta_target_menu_item_id?: string | null;
  is_cart_eligible?: boolean | null;
  offer_mode?: OfferMode | null;
  trigger_type?: OfferTriggerType | null;
  discount_type: OfferDiscountType;
  discount_value: number;
  min_order: number;
  required_item_quantity?: number | null;
  qualifying_category_id?: string | null;
  qualifying_menu_item_id?: string | null;
  reward_menu_item_id?: string | null;
  reward_item_source?: OfferRewardItemSource | null;
  reward_item_quantity?: number | null;
  applies_to_delivery?: boolean;
  applies_to_takeaway?: boolean;
  applies_to_dine_in?: boolean;
  show_on_offers_page?: boolean;
  hide_text_overlay?: boolean;
  valid_from: string;
  valid_until: string;
  is_active: boolean;
}

export interface SelectedCustomization {
  group_name: string;
  option_name: string;
  price: number;
}

export interface CartItem {
  id: string;
  menu_item: MenuItem;
  quantity: number;
  customizations: SelectedCustomization[];
  total_price: number;
}

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'packed'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'expired';

export type OrderType = 'delivery' | 'pickup';
export type PickupOption = 'dine_in' | 'takeaway';
export type PaymentMethod = 'upi' | 'card' | 'cod';
export type PaymentProvider = 'razorpay' | null;
export type CounterPaymentMethod = 'cash' | 'online' | 'split';

export interface Order {
  id: string;
  order_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  address: string;
  pincode: string;
  order_type: OrderType;
  pickup_option: PickupOption;
  delivery_fee: number;
  takeaway_fee: number;
  subtotal: number;
  discount: number;
  total: number;
  payment_method: PaymentMethod;
  payment_provider: PaymentProvider;
  payment_status: string;
  counter_payment_method?: CounterPaymentMethod | null;
  cash_received_amount?: number | null;
  online_received_amount?: number | null;
  paid_amount?: number | null;
  review_reward_coupon_id?: string | null;
  review_reward_discount_amount?: number | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_signature: string | null;
  payment_verified_at: string | null;
  status: OrderStatus;
  placed_at: string;
  confirmed_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  estimated_minutes: number | null;
  queue_position: number | null;
  expires_at: string;
  created_at: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
  house_number: string | null;
  building_name: string | null;
  floor_number: string | null;
  landmark: string | null;
  delivery_instructions: string | null;
  detected_gps_lat: number | null;
  detected_gps_lng: number | null;
  address_confidence: number | null;
  saved_address_id: string | null;
  delivery_partner_id: string | null;
  delivery_partner_lat: number | null;
  delivery_partner_lng: number | null;
  delivery_partner_location_updated_at: string | null;
  delivery_otp: string | null;
  picked_up_at: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  item_name: string;
  quantity: number;
  unit_price: number;
  customizations: SelectedCustomization[];
  created_at?: string;
}

export interface ItemReview {
  id: string;
  user_id: string;
  order_id: string;
  order_item_id: string;
  menu_item_id: string;
  rating: number;
  comment: string;
  created_at: string;
}

export interface ReviewRewardCoupon {
  id: string;
  user_id: string;
  item_review_id: string;
  code: string;
  discount_percentage: number;
  is_redeemed: boolean;
  redeemed_order_id: string | null;
  redeemed_at: string | null;
  created_at: string;
}

export type AddressLabel = 'Home' | 'Work' | 'Other';

export interface SavedAddress {
  id: string;
  user_id: string;
  label: AddressLabel;
  house_number: string;
  building_name: string;
  floor_number: string;
  landmark: string;
  address: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Extended address data returned by MapLocationPicker's onConfirm */
export interface MapConfirmData {
  address: string;
  pincode: string;
  lat: number;
  lng: number;
  houseNumber: string;
  buildingName: string;
  floorNumber: string;
  landmark: string;
  deliveryInstructions: string;
  detectedGpsLat: number | null;
  detectedGpsLng: number | null;
  confidenceScore: number;
  pinManuallyMoved: boolean;
  savedAddressId?: string;
}
