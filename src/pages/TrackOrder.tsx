import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Search, Phone, MessageCircle, ArrowLeft, Package, Bell, PartyPopper, Clock, ChefHat, Users, Sparkles, ArrowRight, Star, CheckCircle, Wallet, BadgeCheck, User, XCircle, MapPin, Navigation, Loader2, KeyRound, CheckCircle2, Route, Timer } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getGoogleMapsKey, getGoogleMapsLoader, STORE_LAT, STORE_LNG, DARK_MAP_STYLE } from '../lib/googlemaps';
import { storePhoneHref, storeWhatsAppHref } from '../lib/storeInfo';
import { clearPendingOnlineOrder, readPendingOnlineOrder } from '../lib/pendingOnlineOrder';
import { getCompletedOrderLabel, getPaymentMethodLabel, getPendingPaymentLabel, getReadyOrderLabel, getServiceModeLabel, isAwaitingCounterPayment, isAwaitingOnlinePayment, isDineInOrder } from '../lib/orderLabels';
import { fetchAccessibleOrderDetails } from '../lib/orderLookup';
import { reconcileRazorpayPayment } from '../lib/razorpay';
import { playOrderCompleteSound, playPickupReadyAlert } from '../lib/sounds';
import type { Order, OrderItem, MenuItem } from '../types';
import OrderTimeline from '../components/OrderTimeline';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { readGuestOrderSnapshot, updateGuestOrderSnapshot } from '../lib/guestOrderSnapshot';

function PrepCountdown({ confirmedAt, estimatedMinutes }: { confirmedAt: string; estimatedMinutes: number }) {
  const [remaining, setRemaining] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    const readyAt = new Date(confirmedAt).getTime() + estimatedMinutes * 60_000;

    function tick() {
      const left = Math.max(0, Math.floor((readyAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && intervalRef.current) clearInterval(intervalRef.current);
    }

    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => clearInterval(intervalRef.current);
  }, [confirmedAt, estimatedMinutes]);

  if (remaining <= 0) {
    return (
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-6 text-center backdrop-blur-sm">
        <Clock size={24} strokeWidth={2.2} className="mx-auto mb-2 text-amber-400" />
        <p className="text-[14px] font-semibold text-amber-400">Almost ready! Just a moment...</p>
      </div>
    );
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const totalSecs = estimatedMinutes * 60;
  const progress = Math.max(0, Math.min(100, ((totalSecs - remaining) / totalSecs) * 100));

  return (
    <div className="rounded-2xl border border-brand-border bg-brand-surface p-6">
      <p className="mb-3 text-center text-[12px] font-semibold uppercase tracking-wider text-brand-text-dim">
        Estimated ready in
      </p>
      <div className="mb-4 flex items-center justify-center gap-2">
        <div className="min-w-[64px] rounded-xl bg-brand-surface-light px-4 py-3 text-center">
          <span className="text-3xl font-black tabular-nums text-white">
            {String(mins).padStart(2, '0')}
          </span>
          <p className="mt-0.5 text-[12px] font-semibold uppercase text-brand-text-dim">min</p>
        </div>
        <span className="px-1 text-2xl font-black tabular-nums text-brand-text-dim">:</span>
        <div className="min-w-[64px] rounded-xl bg-brand-surface-light px-4 py-3 text-center">
          <span className="text-3xl font-black tabular-nums text-white">
            {String(secs).padStart(2, '0')}
          </span>
          <p className="mt-0.5 text-[12px] font-semibold uppercase text-brand-text-dim">sec</p>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-brand-surface-light">
        <div
          className="h-2 rounded-full bg-brand-gold transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-3 text-center text-[12px] font-semibold text-brand-text-dim">
        Your waffles are being freshly made
      </p>
    </div>
  );
}

function getItemCustomizations(item: Pick<OrderItem, 'customizations'>) {
  return Array.isArray(item.customizations) ? item.customizations : [];
}

function getItemLineTotal(item: Pick<OrderItem, 'quantity' | 'unit_price' | 'customizations'>) {
  const customizationTotal = getItemCustomizations(item).reduce((sum, customization) => sum + customization.price, 0);
  return (item.unit_price + customizationTotal) * item.quantity;
}

export default function TrackOrderPage() {
  const { orderId: paramOrderId } = useParams<{ orderId: string }>();
  const { user } = useAuth();
  const [searchId, setSearchId] = useState(paramOrderId || '');
  const [order, setOrder] = useState<Order | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [showReadyBanner, setShowReadyBanner] = useState(false);
  const [queueAhead, setQueueAhead] = useState<number | null>(null);
  const [specials, setSpecials] = useState<MenuItem[]>([]);
  const [reconcilingPayment, setReconcilingPayment] = useState(false);
  const prevStatusRef = useRef<string | null>(null);
  const pickupAlertPlayedRef = useRef(false);
  const reconciledPendingOrderRef = useRef<string | null>(null);
  const { clearCart } = useCart();

  useEffect(() => {
    setSearchId(paramOrderId || '');
  }, [paramOrderId]);

  useEffect(() => {
    void loadSpecials();
  }, []);

  useEffect(() => {
    if (!order) return;

    async function loadQueuePosition(currentOrder: Order) {
      const { count } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('placed_at', currentOrder.placed_at)
        .or('total.lte.0,order_type.eq.delivery,payment_status.eq.paid');

      setQueueAhead(count || 0);
    }

    if (order.order_type === 'pickup' && order.status === 'packed') {
      setShowReadyBanner(true);
      if (!pickupAlertPlayedRef.current) {
        pickupAlertPlayedRef.current = true;
        playPickupReadyAlert();
      }
    } else {
      setShowReadyBanner(false);
    }

    if (user && order.status === 'pending' && !isAwaitingCounterPayment(order)) {
      void loadQueuePosition(order);
    } else {
      setQueueAhead(null);
    }

    if (prevStatusRef.current && prevStatusRef.current !== order.status) {
      if (order.status === 'packed') {
        playOrderCompleteSound();
      }
    }
    prevStatusRef.current = order.status;
  }, [order, user]);

  useEffect(() => {
    if (!order?.order_id || !user) return;

    const channel = supabase
      .channel(`track-${order.order_id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `order_id=eq.${order.order_id}` }, (payload) => {
        const updated = payload.new as Order;
        setOrder(updated);
        if (updated.order_type === 'pickup' && updated.status === 'packed') {
          setShowReadyBanner(true);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [order?.order_id, user]);

  useEffect(() => {
    if (!order || user || !order.customer_email) return;
    if (['delivered', 'cancelled', 'expired'].includes(order.status)) return;

    let isMounted = true;

    const refreshGuestOrder = async () => {
      try {
        const { order: freshOrder, items } = await fetchAccessibleOrderDetails(order.order_id, order.customer_email);
        if (!isMounted) {
          return;
        }

        updateGuestOrderSnapshot(order.order_id, freshOrder);
        setOrder((currentOrder) => currentOrder && currentOrder.order_id === freshOrder.order_id
          ? freshOrder
          : currentOrder);
        setOrderItems(items);
      } catch (error) {
        console.error('Failed to poll guest order status', error);
      }
    };

    void refreshGuestOrder();
    const interval = setInterval(() => {
      void refreshGuestOrder();
    }, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [order, user]);

  useEffect(() => {
    if (!order) return;

    const pendingRecoveryOrderId = readPendingOnlineOrder();
    if (pendingRecoveryOrderId === order.order_id && order.payment_provider === 'razorpay' && order.payment_status === 'paid') {
      clearPendingOnlineOrder(order.order_id);
      clearCart();
      return;
    }

    if (order.payment_status === 'failed' || order.status === 'cancelled' || order.status === 'expired') {
      clearPendingOnlineOrder(order.order_id);
    }
  }, [clearCart, order]);

  useEffect(() => {
    if (!order || !isAwaitingOnlinePayment(order)) {
      setReconcilingPayment(false);
      return;
    }

    if (reconciledPendingOrderRef.current === order.order_id) {
      return;
    }

    reconciledPendingOrderRef.current = order.order_id;
    setReconcilingPayment(true);

    void (async () => {
      try {
        const reconciliation = await reconcileRazorpayPayment(order.order_id, order.customer_email);

        if (reconciliation.paymentState === 'paid') {
          setOrder((currentOrder) => currentOrder && currentOrder.order_id === order.order_id
            ? {
                ...currentOrder,
                payment_status: 'paid',
                payment_provider: 'razorpay',
                payment_method: reconciliation.paymentMethod ?? currentOrder.payment_method,
                status: (reconciliation.orderStatus as Order['status'] | undefined) ?? currentOrder.status,
              }
            : currentOrder);
          return;
        }

        if (reconciliation.paymentState === 'failed') {
          clearPendingOnlineOrder(order.order_id);
          setOrder((currentOrder) => currentOrder && currentOrder.order_id === order.order_id
            ? {
                ...currentOrder,
                payment_status: 'failed',
                status: reconciliation.orderStatus === 'expired'
                  ? 'expired'
                  : (reconciliation.orderStatus as Order['status'] | undefined) ?? currentOrder.status,
              }
            : currentOrder);
        }
      } catch (reconciliationError) {
        console.error('Failed to reconcile Razorpay payment', reconciliationError);
      } finally {
        setReconcilingPayment(false);
      }
    })();
  }, [order]);

  async function loadSpecials() {
    const { data } = await supabase
      .from('menu_items')
      .select('*')
      .eq('is_available', true)
      .order('rating', { ascending: false })
      .limit(6);
    if (data) setSpecials(data);
  }

  const fetchOrder = useCallback(async (id: string) => {
    const normalizedId = id.trim().toUpperCase();

    setLoading(true);
    setSearched(true);
    setShowReadyBanner(false);
    setQueueAhead(null);
    setOrderItems([]);
    prevStatusRef.current = null;
    pickupAlertPlayedRef.current = false;

    if (!user) {
      const guestOrder = readGuestOrderSnapshot(normalizedId);

      if (!guestOrder?.customer_email) {
        setOrder(guestOrder);
        setLoading(false);
        return;
      }

      setOrder(guestOrder);

      try {
        const { order: freshOrder, items } = await fetchAccessibleOrderDetails(normalizedId, guestOrder.customer_email);
        updateGuestOrderSnapshot(normalizedId, freshOrder);
        setOrder(freshOrder);
        setOrderItems(items);
      } catch (error) {
        console.error('Failed to load guest order', error);
      } finally {
        setLoading(false);
      }

      return;
    }

    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', user.id)
      .eq('order_id', normalizedId)
      .maybeSingle();

    if (data) {
      setOrder(data);
      const { data: items } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', data.id);
      setOrderItems(items || []);
    } else {
      setOrder(null);
      setOrderItems([]);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (paramOrderId) {
      void fetchOrder(paramOrderId);
    }
  }, [paramOrderId, fetchOrder]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (searchId.trim()) fetchOrder(searchId);
  }

  const isReadyForPickup = order?.order_type === 'pickup' && order?.status === 'packed';
  const isDeliveryPacked = order?.order_type === 'delivery' && order?.status === 'packed';
  const isDelivered = order?.status === 'delivered';
  const isCancelled = order?.status === 'cancelled';
  const isExpired = order?.status === 'expired';
  const isOnlinePaymentPending = order ? isAwaitingOnlinePayment(order) : false;
  const isCounterPaymentPending = order ? isAwaitingCounterPayment(order) : false;
  const isCounterPaymentPendingBeforeConfirmation = isCounterPaymentPending && order?.status === 'pending';
  const isCounterPaymentPaidAndQueued = !!order && order.order_type === 'pickup' && order.payment_status === 'paid' && order.status === 'pending';
  const isInQueue = order?.status === 'pending' && !isCounterPaymentPendingBeforeConfirmation && !isOnlinePaymentPending;
  const isPreparing = order?.status === 'preparing';
  const isActive = order && !['cancelled', 'expired', 'delivered'].includes(order.status) && !isReadyForPickup && !isCounterPaymentPendingBeforeConfirmation && !isOnlinePaymentPending;
  const showCountdown = isActive && order.estimated_minutes && (order.accepted_at || order.confirmed_at) && ['confirmed', 'preparing'].includes(order.status);
  const serviceModeLabel = order ? getServiceModeLabel(order) : '';
  const readyOrderLabel = order ? getReadyOrderLabel(order) : '';
  const completedOrderLabel = order ? getCompletedOrderLabel(order) : '';
  const isDineIn = order ? isDineInOrder(order) : false;
  const timelineStatus = order
    ? (isCounterPaymentPaidAndQueued ? 'confirmed' : order.status)
    : 'pending';

  return (
    <div className="min-h-screen bg-brand-bg">
      <div className="section-padding py-10">
        <Link
          to="/"
          className="group mb-8 inline-flex items-center gap-2 text-[14px] font-semibold text-brand-text-dim transition-colors hover:text-brand-gold"
        >
          <ArrowLeft size={16} strokeWidth={2.2} className="transition-transform group-hover:-translate-x-0.5" />
          Back to Home
        </Link>

        <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          Track Your Order
        </h1>

        <form onSubmit={handleSearch} className="mb-10 flex max-w-lg gap-3">
          <div className="relative flex-1">
            <Search
              size={18}
              strokeWidth={2.2}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-brand-text-dim"
            />
            <input
              type="text"
              value={searchId}
              onChange={(e) => setSearchId(e.target.value.toUpperCase())}
              placeholder="Enter Order ID (e.g. SW-1)"
              className="input-field pl-10 uppercase"
            />
          </div>
          <button type="submit" className="btn-primary px-6">
            Track
          </button>
        </form>

        {!user && (
          <div className="max-w-lg py-12 text-center">
            <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-brand-surface">
              <User size={32} className="text-brand-text-dim" />
            </div>
            <h3 className="mb-2 text-lg font-bold text-white">Sign in to track your order</h3>
            <p className="text-[14px] font-medium text-brand-text-muted mb-6">
              Order tracking is available for the account that placed the order.
            </p>
            <Link to="/auth" state={{ from: paramOrderId ? `/track/${paramOrderId}` : '/track' }} className="btn-primary">
              Sign In
            </Link>
          </div>
        )}

        {user && loading && (
          <div className="max-w-lg animate-pulse space-y-4">
            <div className="h-8 w-36 rounded-lg bg-brand-surface-light" />
            <div className="h-44 rounded-2xl bg-brand-surface-light" />
          </div>
        )}

        {user && !loading && searched && !order && (
          <div className="max-w-lg py-20 text-center">
            <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-brand-surface">
              <Package size={32} className="text-brand-text-dim" />
            </div>
            <h3 className="mb-2 text-lg font-bold text-white">Order not found</h3>
            <p className="text-[14px] font-medium text-brand-text-muted">
              Please check the order ID and try again
            </p>
          </div>
        )}

        {order && (
          <div className="max-w-lg space-y-6 animate-fade-in">

            {isOnlinePaymentPending && (
              <div className="relative overflow-hidden rounded-2xl bg-sky-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Clock size={32} className={reconcilingPayment ? 'animate-spin' : ''} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Payment Processing</h2>
                  <p className="text-[14px] text-sky-100">
                    {reconcilingPayment
                      ? 'We are checking your online payment now. If money was debited, this order will update automatically.'
                      : 'Your online payment is still being verified. No further action is needed if money was debited.'}
                  </p>
                </div>
              </div>
            )}

            {isCounterPaymentPendingBeforeConfirmation && (
              <div className="relative overflow-hidden rounded-2xl bg-amber-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Wallet size={32} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Awaiting Counter Payment</h2>
                  <p className="text-[14px] text-amber-100">
                    Show your order ID at the counter and complete payment. Your order will join the kitchen queue after staff confirms payment.
                  </p>
                </div>
              </div>
            )}

            {showReadyBanner && isReadyForPickup && (
              <div className="relative overflow-hidden rounded-2xl bg-emerald-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Bell size={32} className="animate-bounce" />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">{readyOrderLabel}!</h2>
                  <p className="mb-4 text-[14px] text-emerald-100">
                    Show order {order.order_id} at the counter for your {serviceModeLabel.toLowerCase()} order
                  </p>
                  <div className="inline-flex items-center gap-2 rounded-full bg-brand-surface-strong/80 px-4 py-2 text-[14px] font-semibold backdrop-blur-sm">
                    <PartyPopper size={16} />
                    Enjoy your waffles!
                  </div>
                </div>
              </div>
            )}

            {isDeliveryPacked && (
              <div className="relative overflow-hidden rounded-2xl bg-sky-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Package size={32} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Order Packed</h2>
                  <p className="text-[14px] text-sky-100">
                    Your order is packed and will move to the next delivery step shortly
                  </p>
                </div>
              </div>
            )}

            {isInQueue && (
              <div className="relative overflow-hidden rounded-2xl bg-orange-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Users size={32} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">{isCounterPaymentPaidAndQueued ? 'Order Confirmed' : 'Your Order is in Queue'}</h2>
                  <p className="text-[14px] text-orange-100 mb-3">
                    {isCounterPaymentPaidAndQueued
                      ? 'Payment confirmed. Your order is now waiting in the kitchen queue.'
                      : 'Please wait while our chef accepts your order'}
                  </p>
                  {queueAhead !== null && queueAhead > 0 && (
                    <div className="inline-flex items-center gap-2 rounded-full bg-brand-surface-strong/80 px-4 py-2 text-[14px] font-semibold backdrop-blur-sm">
                      <Clock size={14} />
                      {queueAhead} order{queueAhead !== 1 ? 's' : ''} ahead of you
                    </div>
                  )}
                  {queueAhead === 0 && (
                    <div className="inline-flex items-center gap-2 rounded-full bg-brand-surface-strong/80 px-4 py-2 text-[14px] font-semibold backdrop-blur-sm">
                      <Clock size={14} />
                      You're next in line!
                    </div>
                  )}
                </div>
              </div>
            )}

            {isPreparing && (
              <div className="relative overflow-hidden rounded-2xl bg-amber-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <ChefHat size={32} className="animate-pulse" />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Your Order is Being Prepared</h2>
                  <p className="text-[14px] text-amber-100">
                    {order.estimated_minutes
                      ? `Please wait, your food will be ready in about ${order.estimated_minutes} minutes`
                      : 'Your food is being freshly prepared'}
                  </p>
                </div>
              </div>
            )}

            {isCancelled && (
              <div className="relative overflow-hidden rounded-2xl bg-red-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <XCircle size={32} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Order Cancelled</h2>
                  <p className="text-[14px] text-red-100">
                    This order was cancelled by the restaurant
                  </p>
                </div>
              </div>
            )}

            {isExpired && (
              <div className="relative overflow-hidden rounded-2xl bg-orange-500 p-6 text-center text-white shadow-elevated animate-scale-in backdrop-blur">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.12),transparent)]" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm">
                    <Clock size={32} />
                  </div>
                  <h2 className="mb-2 text-2xl font-black">Order Expired</h2>
                  <p className="text-[14px] text-orange-100">
                    This order was not confirmed in time
                  </p>
                </div>
              </div>
            )}

            {order.order_type === 'delivery' && order.status === 'out_for_delivery' && (
              <DeliveryLiveTracker order={order} />
            )}

            {isDelivered && (
              <div className="relative overflow-hidden rounded-2xl p-6 text-center shadow-elevated">
                <div className="absolute inset-0 bg-gradient-to-br from-brand-gold/10 to-brand-gold/[0.02] border border-brand-gold/20 rounded-2xl" />
                <div className="relative">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-gold/15 border border-brand-gold/20">
                    <CheckCircle size={32} className="text-brand-gold" />
                  </div>
                  <h2 className="mb-2 text-2xl font-black text-white">
                    {order.order_type === 'pickup' ? 'Enjoy Your Food!' : 'Delivered Successfully!'}
                  </h2>
                  <p className="text-[14px] text-brand-text-muted mb-3">
                    {order.order_type === 'pickup'
                      ? 'Thank you for dining with us. We hope you love every bite!'
                      : 'Your waffles have arrived. Enjoy every bite!'}
                  </p>
                  <div className="inline-flex items-center gap-2 bg-brand-gold/10 border border-brand-gold/20 rounded-full px-4 py-2 text-brand-gold text-[13px] font-bold">
                    <Star size={14} fill="currentColor" />
                    We'd love to see you again soon!
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-brand-border bg-brand-surface p-6 transition-shadow duration-300">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-brand-text-dim">Order</p>
                  <p className="text-2xl font-black tabular-nums text-white">
                    {order.order_id}
                  </p>
                </div>
                <div className="text-right">
                  <span
                    className={`inline-block rounded-full px-3 py-1 text-[12px] font-semibold capitalize ${
                      isOnlinePaymentPending
                        ? 'bg-sky-500/10 text-sky-400'
                        : isCounterPaymentPendingBeforeConfirmation
                        ? 'bg-amber-500/10 text-amber-400'
                        : order.status === 'delivered'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : order.status === 'cancelled' || order.status === 'expired'
                          ? 'bg-red-500/10 text-red-400'
                          : isReadyForPickup
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-brand-gold/10 text-brand-gold'
                    }`}
                  >
                    {isOnlinePaymentPending
                      ? 'payment processing'
                      : isCounterPaymentPendingBeforeConfirmation
                      ? 'payment pending'
                      : isCounterPaymentPaidAndQueued
                      ? 'confirmed'
                      : isReadyForPickup
                      ? readyOrderLabel
                      : order.status === 'delivered'
                        ? completedOrderLabel
                        : order.status.replace('_', ' ')}
                  </span>
                  <p className="mt-1 text-[12px] font-semibold text-brand-text-dim">{serviceModeLabel}</p>
                </div>
              </div>

              <OrderTimeline
                currentStatus={timelineStatus}
                orderType={order.order_type}
                pickupOption={order.pickup_option}
                paymentMethod={order.payment_method}
                paymentProvider={order.payment_provider}
                paymentStatus={order.payment_status}
                total={order.total}
                variant={order.order_type === 'delivery' ? 'horizontal' : 'vertical'}
              />
            </div>

            {showCountdown && (
              <PrepCountdown
                confirmedAt={(order.accepted_at || order.confirmed_at)!}
                estimatedMinutes={order.estimated_minutes!}
              />
            )}

            {isActive && !showCountdown && !isInQueue && !isPreparing && (
              <div className="rounded-2xl bg-brand-gold/10 p-6 backdrop-blur-sm">
                <p className="text-[14px] leading-relaxed text-brand-text-muted">
                  {order.order_type === 'delivery'
                    ? order.status === 'out_for_delivery'
                      ? 'Our delivery partner is on the way with your waffles.'
                      : order.status === 'packed'
                        ? 'Your order is packed and will move to delivery shortly.'
                        : 'Your order is being prepared. Estimated delivery time: ~30 minutes'
                    : isDineIn
                      ? 'We are preparing your dine-in order. We will notify you when it is ready to serve.'
                      : 'We are preparing your takeaway order. You will be notified when it is ready for pickup.'}
                </p>
              </div>
            )}

            {orderItems.length > 0 && (
              <div className="rounded-2xl border border-brand-border bg-brand-surface p-6 transition-shadow duration-300">
                <h3 className="mb-4 text-[14px] font-bold uppercase tracking-wider text-white">
                  Order Details
                </h3>
                <div className="space-y-3">
                  {orderItems.map((item) => (
                    <div key={item.id} className="flex items-start justify-between gap-3 text-[14px]">
                      <div>
                        <span className="text-brand-text-muted">
                          {item.quantity}x {item.item_name}
                        </span>
                        {getItemCustomizations(item).length > 0 && (
                          <div className="mt-1 space-y-1">
                            {getItemCustomizations(item).map((customization, index) => (
                              <p key={`${item.id}-${index}`} className="text-[12px] text-brand-text-dim">
                                {customization.group_name}: {customization.option_name}
                                {customization.price > 0 ? ` (+₹${customization.price})` : ''}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="font-semibold tabular-nums text-white">
                        {'\u20B9'}{getItemLineTotal(item).toFixed(0)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-brand-border pt-3">
                    <span className="font-bold text-white">Total</span>
                    <span className="text-lg font-bold tabular-nums text-brand-gold">
                      {'\u20B9'}{order.total}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[13px] text-brand-text-dim">Service</span>
                    <span className="text-[13px] font-bold text-white">
                      {serviceModeLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[13px] text-brand-text-dim">Payment</span>
                    <span className={`inline-flex items-center gap-1.5 text-[13px] font-bold ${
                      order.payment_status === 'paid' ? 'text-emerald-400' : 'text-brand-text-muted'
                    }`}>
                      {order.payment_status === 'paid'
                        ? <><BadgeCheck size={14} /> {getPaymentMethodLabel(order)}</>
                        : <><Wallet size={14} /> {getPendingPaymentLabel(order)}</>
                      }
                    </span>
                  </div>
                </div>
              </div>
            )}

            {(isDelivered || isReadyForPickup) && specials.length > 0 && (
              <TrackPageSpecials items={specials} />
            )}

            <div className="rounded-2xl border border-brand-border bg-brand-surface p-6 transition-shadow duration-300">
              <h3 className="mb-4 text-[14px] font-bold uppercase tracking-wider text-white">
                Need Help?
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <a
                  href="tel:+919876543210"
                  className="flex items-center justify-center gap-2 rounded-xl border border-brand-border py-3 text-[14px] font-semibold text-brand-text-muted transition-all duration-200 hover:border-brand-gold hover:text-brand-gold"
                >
                  <Phone size={16} strokeWidth={2.2} />
                  Call Us
                </a>
                <a
                  href={`https://wa.me/919876543210?text=Hi, I need help with order ${order.order_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 text-[14px] font-semibold text-white transition-all duration-200 hover:bg-emerald-600"
                >
                  <MessageCircle size={16} strokeWidth={2.2} />
                  WhatsApp
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const CUSTOMER_STEPS = [
  { label: 'Order Confirmed' },
  { label: 'Preparing' },
  { label: 'Ready for Pickup' },
  { label: 'Picked Up' },
  { label: 'On the Way' },
  { label: 'Delivered' },
] as const;

function customerStepIndex(status: Order['status']): number {
  if (status === 'confirmed') return 0;
  if (status === 'preparing') return 1;
  if (status === 'packed') return 2;
  if (status === 'out_for_delivery') return 4;
  if (status === 'delivered') return 5;
  return -1;
}

function CustomerProgressStrip({ status }: { status: Order['status'] }) {
  const activeIdx = customerStepIndex(status);
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
      {CUSTOMER_STEPS.map((step, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <div key={step.label} className="flex items-center flex-shrink-0">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center border-2 transition-all ${
                done ? 'bg-emerald-500 border-emerald-500' : active ? 'bg-sky-500 border-sky-500 animate-pulse' : 'bg-transparent border-white/20'
              }`}>
                {done ? <CheckCircle2 size={12} className="text-white" /> : <span className={`text-[8px] font-bold ${active ? 'text-white' : 'text-white/30'}`}>{i + 1}</span>}
              </div>
              <span className={`text-[9px] font-semibold whitespace-nowrap ${done ? 'text-emerald-400' : active ? 'text-sky-400' : 'text-white/25'}`}>{step.label}</span>
            </div>
            {i < CUSTOMER_STEPS.length - 1 && (
              <div className={`w-3 h-0.5 mt-[-10px] mx-0.5 flex-shrink-0 rounded-full ${done ? 'bg-emerald-500' : 'bg-white/10'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface PartnerProfile {
  full_name: string | null;
  phone: string | null;
}

function LiveDeliveryMap({ order }: { order: Order }) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const partnerMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ durationMin: number; distanceKm: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const hasDestCoords = order.delivery_lat != null && order.delivery_lng != null;
  const hasPartnerCoords = order.delivery_partner_lat != null && order.delivery_partner_lng != null;

  useEffect(() => {
    if (!hasDestCoords || !mapContainerRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        const key = await getGoogleMapsKey();
        if (!key || cancelled || !mapContainerRef.current) return;
        await getGoogleMapsLoader(key).load();
        if (cancelled || !mapContainerRef.current) return;

        const initialCenter = hasPartnerCoords
          ? { lat: order.delivery_partner_lat!, lng: order.delivery_partner_lng! }
          : { lat: STORE_LAT, lng: STORE_LNG };

        const map = new window.google.maps.Map(mapContainerRef.current, {
          center: initialCenter,
          zoom: 13,
          mapTypeId: 'roadmap',
          styles: DARK_MAP_STYLE,
          backgroundColor: '#0f1117',
          disableDefaultUI: true,
          gestureHandling: 'cooperative',
          clickableIcons: false,
        });
        mapRef.current = map;

        // Store marker
        const storeEl = document.createElement('div');
        storeEl.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#D8B24E;border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(216,178,78,0.5);';
        storeEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f1117" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
        new window.google.maps.marker.AdvancedMarkerElement({ position: { lat: STORE_LAT, lng: STORE_LNG }, map, content: storeEl });

        // Destination marker
        const destEl = document.createElement('div');
        destEl.style.cssText = 'width:30px;height:30px;border-radius:50%;background:#10b981;border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(16,185,129,0.5);';
        destEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
        new window.google.maps.marker.AdvancedMarkerElement({ position: { lat: order.delivery_lat!, lng: order.delivery_lng! }, map, content: destEl });

        // Delivery partner marker
        if (hasPartnerCoords) {
          const partnerEl = document.createElement('div');
          partnerEl.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#0ea5e9;border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(14,165,233,0.6);font-size:16px;';
          partnerEl.textContent = '🛵';
          const marker = new window.google.maps.marker.AdvancedMarkerElement({
            position: { lat: order.delivery_partner_lat!, lng: order.delivery_partner_lng! },
            map,
            content: partnerEl,
          });
          partnerMarkerRef.current = marker;
        }

        // Fit bounds to show all points
        const bounds = new window.google.maps.LatLngBounds();
        bounds.extend({ lat: STORE_LAT, lng: STORE_LNG });
        bounds.extend({ lat: order.delivery_lat!, lng: order.delivery_lng! });
        if (hasPartnerCoords) bounds.extend({ lat: order.delivery_partner_lat!, lng: order.delivery_partner_lng! });
        map.fitBounds(bounds, 52);

        // Get route distance/time
        if (hasPartnerCoords) {
          const directionsService = new window.google.maps.DirectionsService();
          directionsService.route({
            origin: { lat: order.delivery_partner_lat!, lng: order.delivery_partner_lng! },
            destination: { lat: order.delivery_lat!, lng: order.delivery_lng! },
            travelMode: window.google.maps.TravelMode.DRIVING,
            region: 'IN',
          }, (result, status) => {
            if (cancelled) return;
            if (status === window.google.maps.DirectionsStatus.OK && result) {
              const leg = result.routes[0]?.legs[0];
              if (leg) setRouteInfo({ durationMin: Math.ceil((leg.duration?.value ?? 0) / 60), distanceKm: Math.round((leg.distance?.value ?? 0) / 100) / 10 });
            }
          });
        }

        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; mapRef.current = null; partnerMarkerRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update partner marker position when coords change
  useEffect(() => {
    if (!partnerMarkerRef.current || !order.delivery_partner_lat || !order.delivery_partner_lng) return;
    partnerMarkerRef.current.position = { lat: order.delivery_partner_lat, lng: order.delivery_partner_lng };
  }, [order.delivery_partner_lat, order.delivery_partner_lng]);

  if (!hasDestCoords) return null;

  return (
    <div className="rounded-2xl overflow-hidden border border-sky-500/20">
      {routeInfo && (
        <div className="flex items-center gap-4 px-3 py-2 bg-sky-500/10 border-b border-sky-500/15">
          <div className="flex items-center gap-1.5 text-sky-400">
            <Timer size={13} />
            <span className="text-[12px] font-bold">~{routeInfo.durationMin} min away</span>
          </div>
          <div className="flex items-center gap-1.5 text-brand-text-dim">
            <Route size={13} />
            <span className="text-[12px] font-semibold">{routeInfo.distanceKm} km</span>
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-brand-text-dim">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400 inline-block" /> Partner</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> You</span>
          </div>
        </div>
      )}
      {loading ? (
        <div className="h-[220px] bg-brand-bg flex items-center justify-center gap-2 text-brand-text-dim text-[13px]">
          <Loader2 size={16} className="animate-spin text-sky-400" /><span>Loading map...</span>
        </div>
      ) : (
        <div ref={mapContainerRef} style={{ height: 240 }} />
      )}
    </div>
  );
}

function DeliveryLiveTracker({ order }: { order: Order }) {
  const [partnerProfile, setPartnerProfile] = useState<PartnerProfile | null>(null);

  useEffect(() => {
    if (!order.delivery_partner_id) return;
    supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', order.delivery_partner_id)
      .maybeSingle()
      .then(({ data }) => { if (data) setPartnerProfile(data as PartnerProfile); });
  }, [order.delivery_partner_id]);

  const partnerName = partnerProfile?.full_name || 'Delivery Partner';
  const partnerPhone = partnerProfile?.phone;
  const hasPartnerLoc = order.delivery_partner_lat != null && order.delivery_partner_lng != null;

  return (
    <div className="space-y-3">
      {/* Live tracking header */}
      <div className="rounded-2xl border border-sky-500/25 bg-sky-500/5 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-sky-500/15">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse flex-shrink-0" />
          <span className="text-[12px] font-bold text-sky-300 uppercase tracking-wider">Live Tracking</span>
          {hasPartnerLoc && order.delivery_partner_location_updated_at && (
            <span className="ml-auto text-[10px] text-brand-text-dim">Updated just now</span>
          )}
        </div>

        {/* Live map */}
        <div className="p-3">
          {hasPartnerLoc ? (
            <LiveDeliveryMap order={order} />
          ) : (
            <div className="h-[140px] bg-brand-bg rounded-xl flex flex-col items-center justify-center gap-2">
              <Navigation size={24} className="text-sky-400 animate-pulse" />
              <p className="text-[12px] text-brand-text-dim">Waiting for partner location...</p>
            </div>
          )}
        </div>
      </div>

      {/* Progress strip */}
      <div className="rounded-2xl border border-brand-border bg-brand-surface p-3">
        <CustomerProgressStrip status={order.status} />
      </div>

      {/* Delivery partner card */}
      <div className="rounded-2xl border border-brand-border bg-brand-surface p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-text-dim mb-3">Delivery Partner</p>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-sky-500/30 to-sky-700/30 border-2 border-sky-500/30 flex items-center justify-center text-xl flex-shrink-0">
            🛵
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-bold text-white truncate">{partnerName}</p>
            <p className="text-[12px] text-brand-text-dim">Your delivery partner</p>
          </div>
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-brand-surface flex-shrink-0" />
        </div>
        {partnerPhone && (
          <div className="flex gap-2">
            <a href={`tel:${partnerPhone}`} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-brand-surface-light border border-brand-border text-[13px] font-bold text-white hover:bg-white/10 transition-colors">
              <Phone size={13} className="text-sky-400" /> Call
            </a>
            <a href={`https://wa.me/${partnerPhone.replace(/\D/g, '')}?text=Hi, I'm waiting for order ${order.order_id}`} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[13px] font-bold text-emerald-400 hover:bg-emerald-500/20 transition-colors">
              <MessageCircle size={13} /> WhatsApp
            </a>
          </div>
        )}
      </div>

      {/* Delivery OTP */}
      {order.delivery_otp && (
        <div className="rounded-2xl border border-brand-gold/30 bg-brand-gold/5 p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <KeyRound size={15} className="text-brand-gold" />
            <p className="text-[12px] font-bold text-brand-gold uppercase tracking-wider">Your Delivery OTP</p>
          </div>
          <p className="text-4xl font-black text-white tracking-[0.4em] mb-2">{order.delivery_otp}</p>
          <p className="text-[11px] text-brand-text-dim">Share this code with the delivery partner to confirm receipt</p>
        </div>
      )}

      {/* Delivery address */}
      {order.address && (
        <div className="rounded-2xl border border-brand-border bg-brand-surface p-4">
          <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-text-dim mb-2">Delivering to</p>
          <div className="flex items-start gap-2">
            <MapPin size={14} className="text-sky-400 flex-shrink-0 mt-0.5" />
            <div>
              {order.house_number && <p className="text-[13px] font-semibold text-white">{order.house_number}{order.building_name ? `, ${order.building_name}` : ''}</p>}
              <p className="text-[12px] text-brand-text-muted">{order.address}</p>
            </div>
          </div>
        </div>
      )}

      {/* Restaurant contact */}
      <div className="rounded-2xl border border-brand-border bg-brand-surface p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-widest text-brand-text-dim mb-3">Restaurant</p>
        <div className="flex gap-2">
          <a href={storePhoneHref} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-brand-surface-light border border-brand-border text-[12px] font-bold text-white hover:bg-white/10 transition-colors">
            <Phone size={12} className="text-brand-gold" /> Call Store
          </a>
          <a href={storeWhatsAppHref} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[12px] font-bold text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            <MessageCircle size={12} /> WhatsApp
          </a>
        </div>
      </div>
    </div>
  );
}

function TrackPageSpecials({ items }: { items: MenuItem[] }) {
  return (
    <div className="rounded-2xl border border-brand-gold/15 bg-gradient-to-b from-brand-gold/[0.04] to-transparent p-5 text-left animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-brand-gold/10 rounded-lg flex items-center justify-center">
          <Sparkles size={16} className="text-brand-gold" />
        </div>
        <div>
          <h3 className="text-[14px] font-bold text-white">Today's Top Picks</h3>
          <p className="text-[12px] text-brand-text-dim font-medium">Craving more? Try these favorites</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2.5 mb-4">
        {items.slice(0, 3).map((item) => (
          <Link
            key={item.id}
            to="/menu"
            className="group rounded-xl overflow-hidden border border-brand-border bg-brand-surface hover:border-brand-gold/30 transition-all"
          >
            <div className="aspect-square overflow-hidden">
              <img
                src={item.image_url}
                alt={item.name}
                loading="lazy"
                width={200}
                height={200}
                className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
              />
            </div>
            <div className="p-2">
              <p className="text-[11px] font-bold text-white truncate leading-tight">{item.name}</p>
              <p className="text-[12px] font-extrabold text-brand-gold mt-0.5">{'\u20B9'}{item.price}</p>
            </div>
          </Link>
        ))}
      </div>

      {items.length > 3 && (
        <div className="space-y-2 mb-4">
          {items.slice(3, 6).map((item) => (
            <Link
              key={item.id}
              to="/menu"
              className="flex items-center gap-3 rounded-xl bg-brand-surface border border-brand-border p-2.5 hover:border-brand-gold/20 transition-all group"
            >
              <img
                src={item.image_url}
                alt={item.name}
                loading="lazy"
                width={44}
                height={44}
                className="w-11 h-11 rounded-lg object-cover shrink-0 group-hover:scale-105 transition-transform"
              />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-white truncate">{item.name}</p>
                <p className="text-[12px] font-semibold text-brand-text-dim">{'\u20B9'}{item.price}</p>
              </div>
              <ArrowRight size={14} className="text-brand-text-dim group-hover:text-brand-gold shrink-0 transition-colors" />
            </Link>
          ))}
        </div>
      )}

      <Link
        to="/menu"
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-brand-gold/10 border border-brand-gold/20 text-brand-gold text-[13px] font-bold hover:bg-brand-gold/15 transition-all"
      >
        View Full Menu
        <ArrowRight size={14} />
      </Link>
    </div>
  );
}
