import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle, Clock, Copy, RotateCcw, Store, Truck, ChefHat, Users, Bell, Sparkles, ArrowRight, Star, Wallet, Package, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clearCheckoutSuccessOrder } from '../lib/checkoutSuccess';
import { clearPendingOnlineOrder, readPendingOnlineOrder } from '../lib/pendingOnlineOrder';
import { supabase } from '../lib/supabase';
import { getPaymentMethodLabel, getPendingPaymentLabel, getReadyOrderLabel, getServiceModeLabel, isAwaitingCounterPayment, isAwaitingOnlinePayment } from '../lib/orderLabels';
import { fetchAccessibleOrderDetails } from '../lib/orderLookup';
import { RAZORPAY_BRAND_IMAGE, buildRazorpayCallbackUrl, cancelRazorpayPayment, createExistingRazorpayOrder, loadRazorpayScript, reconcileRazorpayPayment, verifyRazorpayPayment } from '../lib/razorpay';
import { getRazorpayPrefillContact } from '../lib/checkoutCustomer';
import type { Order, MenuItem, OrderStatus } from '../types';
import { useToast } from '../components/Toast';
import { playOrderSound, playOrderCompleteSound, playPickupReadyAlert } from '../lib/sounds';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { staggerContainer, staggerChild } from '../lib/animations';
import { readGuestOrderSnapshot, updateGuestOrderSnapshot } from '../lib/guestOrderSnapshot';

const SESSION_KEYWORDS = ['session expired', 'sign in again', 'please sign in', 'authentication failed'];
const ORDER_STATUS_VALUES: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'packed',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'expired',
];

function parseOrderStatus(value: string | null) {
  return ORDER_STATUS_VALUES.includes(value as OrderStatus) ? value as OrderStatus : undefined;
}

function parseRazorpayPaymentMethod(value: string | null) {
  return value === 'upi' || value === 'card' ? value : undefined;
}

export default function OrderSuccessPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [specials, setSpecials] = useState<MenuItem[]>([]);
  const [payingOnline, setPayingOnline] = useState(false);
  const [reconcilingPayment, setReconcilingPayment] = useState(false);
  const [paymentCheckDelayed, setPaymentCheckDelayed] = useState(false);
  const [canCancelOrder, setCanCancelOrder] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const verifyingStartTimeRef = useRef<number | null>(null);
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToast();
  const prevStatusRef = useRef<string | null>(null);
  const pickupAlertPlayedRef = useRef(false);
  const reconciledPendingOrderRef = useRef<string | null>(null);
  const pollCountRef = useRef(0);
  const { clearCart } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    if (!orderId || searchParams.get('source') !== 'razorpay_callback') {
      return;
    }

    const paymentState = searchParams.get('payment_state');
    const callbackOrderStatus = parseOrderStatus(searchParams.get('order_status'));
    const callbackPaymentMethod = parseRazorpayPaymentMethod(searchParams.get('payment_method'));
    const manualReview = searchParams.get('manual_review') === 'true';

    if (paymentState === 'paid') {
      const updates: Partial<Order> = {
        payment_status: 'paid',
        payment_provider: 'razorpay',
        payment_verified_at: new Date().toISOString(),
        ...(callbackPaymentMethod ? { payment_method: callbackPaymentMethod } : {}),
        ...(callbackOrderStatus ? { status: callbackOrderStatus } : {}),
      };

      updateGuestOrderSnapshot(orderId, updates);
      setOrder((currentOrder) => currentOrder && currentOrder.order_id === orderId
        ? { ...currentOrder, ...updates }
        : currentOrder);
      clearPendingOnlineOrder(orderId);
      clearCart();
      showToast(manualReview ? 'Payment received. We are reviewing your order.' : 'Payment confirmed');
    } else if (paymentState === 'failed') {
      const updates: Partial<Order> = {
        payment_status: 'failed',
        ...(callbackOrderStatus ? { status: callbackOrderStatus } : {}),
      };

      updateGuestOrderSnapshot(orderId, updates);
      setOrder((currentOrder) => currentOrder && currentOrder.order_id === orderId
        ? { ...currentOrder, ...updates }
        : currentOrder);
      clearPendingOnlineOrder(orderId);
      showToast('Payment could not be completed.', 'error');
    } else if (paymentState === 'pending') {
      pollCountRef.current = 0;
      reconciledPendingOrderRef.current = null;
      setPaymentCheckDelayed(false);
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    ['source', 'payment_state', 'order_status', 'payment_method', 'manual_review', 'callback_error'].forEach((key) => {
      nextSearchParams.delete(key);
    });
    setSearchParams(nextSearchParams, { replace: true });
  }, [clearCart, orderId, searchParams, setSearchParams, showToast]);

  useEffect(() => {
    if (orderId) {
      clearCheckoutSuccessOrder(orderId);
    }
  }, [orderId]);

  useEffect(() => {
    playOrderSound();

    let isMounted = true;

    async function loadSpecials() {
      const { data } = await supabase
        .from('menu_items')
        .select('*')
        .eq('is_available', true)
        .order('rating', { ascending: false })
        .limit(6);

      if (isMounted && data) {
        setSpecials(data);
      }
    }

    void loadSpecials();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!orderId) {
      setOrder(null);
      setLoading(false);
      return;
    }

    let isMounted = true;

    prevStatusRef.current = null;
    pickupAlertPlayedRef.current = false;
    setLoading(true);
    const currentOrderId = orderId;

    async function loadOrder() {
      if (!user) {
        const guestOrder = readGuestOrderSnapshot(currentOrderId);
        if (!isMounted) {
          return;
        }

        setOrder(guestOrder);
        setLoading(false);

        if (!guestOrder?.customer_email) {
          return;
        }

        try {
          const { order: freshOrder } = await fetchAccessibleOrderDetails(currentOrderId, guestOrder.customer_email);
          if (!isMounted) {
            return;
          }

          updateGuestOrderSnapshot(currentOrderId, freshOrder);
          setOrder(freshOrder);
        } catch (error) {
          console.error('Failed to refresh guest order', error);
        }
        return;
      }

      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', user.id)
        .eq('order_id', currentOrderId)
        .maybeSingle();

      if (!isMounted) {
        return;
      }

      setOrder(data ?? readGuestOrderSnapshot(currentOrderId));
      setLoading(false);
    }

    void loadOrder();

    return () => {
      isMounted = false;
    };
  }, [orderId, user]);

  useEffect(() => {
    if (!order) return;

    const currentOrder = order;

    if (prevStatusRef.current && prevStatusRef.current !== currentOrder.status) {
      if (currentOrder.status === 'preparing') {
        showToast('Chef accepted your order!');
      } else if (currentOrder.status === 'packed') {
        if (currentOrder.order_type === 'pickup') {
          playOrderCompleteSound();
          showToast('Your order is ready!');
        } else {
          showToast('Your order is packed and dispatching soon.');
        }
      } else if (currentOrder.status === 'out_for_delivery') {
        showToast('Your order is on the way!');
      } else if (currentOrder.status === 'cancelled') {
        showToast('This order has been cancelled.', 'error');
      }
    }

    if (currentOrder.status === 'packed' && currentOrder.order_type === 'pickup' && !pickupAlertPlayedRef.current) {
      pickupAlertPlayedRef.current = true;
      playPickupReadyAlert();
    }

    prevStatusRef.current = currentOrder.status;

    if (!user) {
      return;
    }

    const channel = supabase
      .channel(`order-${currentOrder.order_id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `order_id=eq.${currentOrder.order_id}` }, (payload) => {
        setOrder(payload.new as Order);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [order, showToast, user]);

  useEffect(() => {
    if (!order || user || !order.customer_email) return;
    if (['delivered', 'cancelled', 'expired'].includes(order.status)) return;

    let isMounted = true;

    const refreshGuestOrder = async () => {
      try {
        const { order: freshOrder } = await fetchAccessibleOrderDetails(order.order_id, order.customer_email);
        if (!isMounted) {
          return;
        }

        updateGuestOrderSnapshot(order.order_id, freshOrder);
        setOrder((currentOrder) => currentOrder && currentOrder.order_id === freshOrder.order_id
          ? freshOrder
          : currentOrder);
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
    if (pendingRecoveryOrderId !== order.order_id) {
      if (order.payment_status === 'failed' || order.status === 'cancelled' || order.status === 'expired') {
        clearPendingOnlineOrder(order.order_id);
      }
      return;
    }

    if (order.payment_provider === 'razorpay' && order.payment_status !== 'failed' && order.status !== 'cancelled' && order.status !== 'expired') {
      clearCart();
    }

    if (order.payment_provider === 'razorpay' && order.payment_status === 'paid') {
      clearPendingOnlineOrder(order.order_id);
      return;
    }

    if (order.payment_status === 'failed' || order.status === 'cancelled' || order.status === 'expired') {
      clearPendingOnlineOrder(order.order_id);
    }
  }, [clearCart, order]);

  useEffect(() => {
    if (!order || !isAwaitingOnlinePayment(order)) {
      pollCountRef.current = 0;
      setPaymentCheckDelayed(false);
      return;
    }

    if (paymentCheckDelayed) return;

    const interval = setInterval(async () => {
      pollCountRef.current += 1;

      if (pollCountRef.current >= 5) {
        setPaymentCheckDelayed(true);
        // Immediately trigger reconciliation after the fast-poll window closes
        // instead of waiting for the user to tap "Check again".
        // This is the critical path for UPI users who pay and close their UPI app.
        reconciledPendingOrderRef.current = null;
        setOrder((prev) => prev ? { ...prev } : prev);
        return;
      }

      try {
        let fresh: Order | null = null;

        if (user) {
          const { data } = await supabase
            .from('orders')
            .select('*')
            .eq('user_id', user.id)
            .eq('order_id', order.order_id)
            .maybeSingle();
          fresh = data as Order | null;
        }

        if (fresh && fresh.payment_status !== order.payment_status) {
          setOrder(fresh);
        } else if (!fresh || fresh.payment_status === 'pending') {
          reconciledPendingOrderRef.current = null;
          setOrder((prev) => prev ? { ...prev } : prev);
        }
      } catch (pollError) {
        console.error('Failed to poll order status', pollError);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [order, user, paymentCheckDelayed]);

  useEffect(() => {
    if (!order || !isAwaitingCounterPayment(order)) return;
    void loadRazorpayScript().catch((error) => {
      console.error('Failed to preload Razorpay checkout', error);
    });
  }, [order]);

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

    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const reconciliation = await reconcileRazorpayPayment(order.order_id, order.customer_email);

        if (reconciliation.paymentState === 'paid') {
          updateGuestOrderSnapshot(order.order_id, {
            payment_status: 'paid',
            payment_provider: 'razorpay',
            payment_method: reconciliation.paymentMethod ?? order.payment_method,
            status: (reconciliation.orderStatus as Order['status'] | undefined) ?? order.status,
            payment_verified_at: new Date().toISOString(),
          });
          setOrder((currentOrder) => currentOrder && currentOrder.order_id === order.order_id
            ? {
                ...currentOrder,
                payment_status: 'paid',
                payment_provider: 'razorpay',
                payment_method: reconciliation.paymentMethod ?? currentOrder.payment_method,
                status: (reconciliation.orderStatus as Order['status'] | undefined) ?? currentOrder.status,
              }
            : currentOrder);
          showToast('Payment confirmed');
          return;
        }

        if (reconciliation.paymentState === 'failed') {
          clearPendingOnlineOrder(order.order_id);
          updateGuestOrderSnapshot(order.order_id, {
            payment_status: 'failed',
            status: reconciliation.orderStatus === 'expired'
              ? 'expired'
              : (reconciliation.orderStatus as Order['status'] | undefined) ?? order.status,
          });
          setOrder((currentOrder) => currentOrder && currentOrder.order_id === order.order_id
            ? {
                ...currentOrder,
                payment_status: 'failed',
                status: reconciliation.orderStatus === 'expired'
                  ? 'expired'
                  : (reconciliation.orderStatus as Order['status'] | undefined) ?? currentOrder.status,
              }
            : currentOrder);
          showToast('We could not confirm this payment.', 'error');
          return;
        }

        // paymentState === 'pending': schedule a direct retry in 2s without waiting for the poll
        reconciledPendingOrderRef.current = null;
        retryTimer = setTimeout(() => {
          setOrder((prev) => prev ? { ...prev } : prev);
        }, 2000);
      } catch (reconciliationError) {
        console.error('Failed to reconcile Razorpay payment', reconciliationError);
        reconciledPendingOrderRef.current = null;
        retryTimer = setTimeout(() => {
          setOrder((prev) => prev ? { ...prev } : prev);
        }, 2000);
      } finally {
        setReconcilingPayment(false);
      }
    })();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [order, showToast]);

  useEffect(() => {
    if (!order || !isAwaitingOnlinePayment(order)) {
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = null;
      verifyingStartTimeRef.current = null;
      setCanCancelOrder(false);
      setShowCancelConfirm(false);
      return;
    }

    if (canCancelOrder) return;

    if (verifyingStartTimeRef.current === null) {
      verifyingStartTimeRef.current = Date.now();
    }

    const elapsed = Date.now() - verifyingStartTimeRef.current;
    const remaining = 120_000 - elapsed;

    if (remaining <= 0) {
      setCanCancelOrder(true);
      return;
    }

    cancelTimerRef.current = setTimeout(() => {
      setCanCancelOrder(true);
    }, remaining);

    return () => {
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
    };
  }, [order, canCancelOrder]);

  async function handleCancelOrder() {
    if (!order || cancellingOrder) return;
    setCancellingOrder(true);
    try {
      await cancelRazorpayPayment(order.order_id, order.customer_email);
      clearPendingOnlineOrder(order.order_id);
      updateGuestOrderSnapshot(order.order_id, { payment_status: 'failed', status: 'cancelled' });
      setOrder((prev) => prev ? { ...prev, payment_status: 'failed', status: 'cancelled' } : prev);
      showToast('Order cancelled.');
    } catch {
      showToast('Could not cancel order. Please try again.', 'error');
    } finally {
      setCancellingOrder(false);
      setShowCancelConfirm(false);
    }
  }

  async function copyOrderId() {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.order_id);
      showToast('Order ID copied!');
    } catch {
      showToast('Could not copy — please select and copy manually.', 'error');
    }
  }

  async function handleCheckPaymentAgain() {
    pollCountRef.current = 0;
    reconciledPendingOrderRef.current = null;
    setPaymentCheckDelayed(false);

    if (user && order) {
      try {
        const { data } = await supabase
          .from('orders')
          .select('*')
          .eq('user_id', user.id)
          .eq('order_id', order.order_id)
          .maybeSingle();
        if (data) setOrder(data as Order);
      } catch (err) {
        console.error('Failed to refresh order', err);
      }
      return;
    }

    if (order?.customer_email) {
      try {
        const { order: freshOrder } = await fetchAccessibleOrderDetails(order.order_id, order.customer_email);
        updateGuestOrderSnapshot(order.order_id, freshOrder);
        setOrder(freshOrder);
      } catch (err) {
        console.error('Failed to refresh guest order', err);
      }
    }
  }

  async function handlePayOnlineNow() {
    if (!order || payingOnline) return;

    setPayingOnline(true);

    try {
      const razorpayScriptPromise = loadRazorpayScript();
      const razorpayOrder = await createExistingRazorpayOrder(order.order_id, order.customer_email);
      const razorpayCallbackUrl = buildRazorpayCallbackUrl(razorpayOrder.appOrderId);

      await razorpayScriptPromise;

      const RazorpayCheckout = window.Razorpay;
      if (!RazorpayCheckout) {
        throw new Error('Razorpay checkout is unavailable');
      }

      const verificationResult = await new Promise<{
        paymentMethod?: 'upi' | 'card';
        paymentState?: 'paid' | 'pending' | 'failed';
        orderStatus?: string;
      }>((resolve, reject) => {
        let paymentFinalized = false;

        const checkout = new RazorpayCheckout({
          key: razorpayOrder.keyId,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency,
          name: 'The Supreme Waffle',
          image: RAZORPAY_BRAND_IMAGE,
          description: `${serviceModeLabel} Order`,
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
              reject(new Error('Payment cancelled'));
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
                if (verification.paymentState === 'failed') {
                  reject(new Error(verification.error || 'Payment verification failed'));
                  return;
                }
                resolve({
                  paymentMethod: verification.paymentMethod,
                  paymentState: verification.paymentState,
                  orderStatus: verification.orderStatus,
                });
              } catch (verificationError) {
                reject(verificationError instanceof Error ? verificationError : new Error('Payment verification failed'));
              }
            })();
          },
        });

        checkout.on('payment.failed', (failure) => {
          if (paymentFinalized) return;
          paymentFinalized = true;
          reject(new Error(failure.error?.description || 'Payment failed'));
        });

        checkout.open();
      });

      const resolvedPaymentMethod = verificationResult.paymentMethod === 'upi' ? 'upi' : 'card';
      const resolvedOrderStatus = verificationResult.orderStatus as Order['status'] | undefined;

      if (verificationResult.paymentState === 'pending') {
        setOrder((currentOrder) => currentOrder ? {
          ...currentOrder,
          payment_status: 'pending',
          payment_provider: 'razorpay',
          payment_method: resolvedPaymentMethod,
          ...(resolvedOrderStatus ? { status: resolvedOrderStatus } : {}),
        } : currentOrder);
        updateGuestOrderSnapshot(order.order_id, {
          payment_status: 'pending',
          payment_provider: 'razorpay',
          payment_method: resolvedPaymentMethod,
          ...(resolvedOrderStatus ? { status: resolvedOrderStatus } : {}),
        });
        showToast('Payment received. We are verifying your order.');
        return;
      }

      setOrder((currentOrder) => currentOrder ? {
        ...currentOrder,
        payment_status: 'paid',
        payment_provider: 'razorpay',
        payment_method: resolvedPaymentMethod,
        ...(resolvedOrderStatus ? { status: resolvedOrderStatus } : {}),
      } : currentOrder);
      updateGuestOrderSnapshot(order.order_id, {
        payment_status: 'paid',
        payment_provider: 'razorpay',
        payment_method: resolvedPaymentMethod,
        payment_verified_at: new Date().toISOString(),
        ...(resolvedOrderStatus ? { status: resolvedOrderStatus } : {}),
      });
      showToast('Payment completed successfully');
    } catch (paymentError) {
      const message = paymentError instanceof Error ? paymentError.message : 'Failed to complete online payment';
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes('already paid')) {
        setOrder((currentOrder) => currentOrder && currentOrder.order_id === order.order_id
          ? {
              ...currentOrder,
              payment_status: 'paid',
              payment_provider: 'razorpay',
              payment_verified_at: currentOrder.payment_verified_at ?? new Date().toISOString(),
            }
          : currentOrder);
        updateGuestOrderSnapshot(order.order_id, {
          payment_status: 'paid',
          payment_provider: 'razorpay',
          payment_verified_at: new Date().toISOString(),
        });
        showToast('Payment already completed');
        return;
      }

      console.error('Failed to complete online payment', paymentError);
      const isSessionError = SESSION_KEYWORDS.some((keyword) => lowerMessage.includes(keyword));
      if (isSessionError && user) {
        navigate('/auth', { state: { from: `/order-success/${order.order_id}` }, replace: true });
      }
      showToast(message === 'Payment cancelled' ? 'Payment cancelled' : message, 'error');
    } finally {
      setPayingOnline(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center bg-brand-bg">
        <div className="animate-pulse text-center">
          <div className="w-20 h-20 bg-brand-surface-light rounded-full mx-auto mb-6" />
          <div className="h-6 bg-brand-surface-light rounded-2xl w-44 mx-auto mb-3" />
          <div className="h-4 bg-brand-surface-light rounded-2xl w-64 mx-auto" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center section-padding text-center bg-brand-bg">
        <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Order Not Found</h2>
        <p className="text-brand-text-muted text-[14px] mb-6">We couldn't find an order with that ID</p>
        <Link to="/menu" className="btn-primary">Browse Menu</Link>
      </div>
    );
  }

  const isExpired = order.status === 'expired';
  const isCancelled = order.status === 'cancelled';
  const isPending = order.status === 'pending';
  const isPickup = order.order_type === 'pickup';
  const isOnlinePaymentPending = isAwaitingOnlinePayment(order);
  const isCounterPaymentPending = isAwaitingCounterPayment(order);
  const isCounterPaymentPendingBeforeAcceptance = isCounterPaymentPending && isPending;
  const isCounterPaymentPendingAfterAcceptance = isCounterPaymentPending && !isPending;
  const isQueuePending = isPending && !isCounterPaymentPendingBeforeAcceptance && !isOnlinePaymentPending;
  const isPreparing = order.status === 'preparing';
  const isPickupReady = isPickup && order.status === 'packed';
  const isDeliveryPacked = !isPickup && order.status === 'packed';
  const isOutForDelivery = order.status === 'out_for_delivery';
  const isDelivered = order.status === 'delivered';
  const isConfirmed = order.status === 'confirmed';
  const showSpecials = isDelivered || isPickupReady;
  const serviceModeLabel = getServiceModeLabel(order);
  const readyOrderLabel = getReadyOrderLabel(order);

  return (
    <div className="min-h-[60vh] flex items-center justify-center section-padding py-12 bg-brand-bg">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-md w-full text-center"
      >

        <AnimatePresence mode="wait">
        {isPickupReady && (
          <motion.div key="ready" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <PickupReadyBanner order={order} />
          </motion.div>
        )}

        {isDeliveryPacked && (
          <motion.div key="delivery-packed" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-sky-500/10 border border-sky-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Package size={40} className="text-sky-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Order Packed!</h1>
            <p className="text-brand-text-muted mb-8">
              Your order is packed and will move to the next delivery step shortly.
            </p>
          </motion.div>
        )}

        {isPreparing && (
          <motion.div key="preparing" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-amber-500/10 border border-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <ChefHat size={40} className="text-amber-400 animate-pulse" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Your Order is Being Prepared!</h1>
            <p className="text-brand-text-muted mb-8">
              Our chef is making your order fresh. {order.estimated_minutes ? `Please wait about ${order.estimated_minutes} minutes.` : ''}
            </p>
          </motion.div>
        )}

        {isOnlinePaymentPending && (
          <motion.div key="online-payment-pending" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-sky-500/10 border border-sky-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Clock size={40} className={reconcilingPayment ? 'text-sky-400 animate-spin' : 'text-sky-400 animate-pulse'} />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">
              {reconcilingPayment ? 'Verifying your payment...' : 'Waiting for Payment'}
            </h1>
            <p className="text-brand-text-muted mb-4">
              {reconcilingPayment
                ? 'Checking with Razorpay — this usually takes a few seconds.'
                : paymentCheckDelayed
                  ? 'If you already paid via UPI (PhonePe, GPay, etc.) and closed the app, your payment is safe. We are confirming it now.'
                  : 'If you paid via UPI and closed the app, stay on this page — we will confirm your payment automatically.'}
            </p>
            {paymentCheckDelayed && !reconcilingPayment && (
              <button
                onClick={() => { void handleCheckPaymentAgain(); }}
                className="btn-primary mb-8"
              >
                Check Payment Status
              </button>
            )}
            {canCancelOrder && !reconcilingPayment && !showCancelConfirm && (
              <div className="mt-2 mb-8">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-brand-text-muted">Having trouble?</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  className="w-full py-2.5 px-4 rounded-xl border border-rose-500/40 text-rose-400 text-sm font-medium hover:bg-rose-500/10 transition-colors"
                >
                  Cancel this order
                </button>
              </div>
            )}
            {canCancelOrder && showCancelConfirm && (
              <div className="mt-2 mb-8 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4">
                <p className="text-sm font-semibold text-rose-300 mb-1">Cancel this order?</p>
                <p className="text-xs text-brand-text-muted mb-4">If your payment went through, you may not receive a refund. Only cancel if you are sure the payment did not complete.</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowCancelConfirm(false)}
                    disabled={cancellingOrder}
                    className="flex-1 py-2.5 rounded-xl border border-white/15 text-sm font-medium text-brand-text-muted hover:bg-white/5 transition-colors disabled:opacity-50"
                  >
                    Go back
                  </button>
                  <button
                    onClick={() => { void handleCancelOrder(); }}
                    disabled={cancellingOrder}
                    className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {cancellingOrder && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                    {cancellingOrder ? 'Cancelling...' : 'Yes, cancel'}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {isCounterPaymentPendingBeforeAcceptance && (
          <motion.div key="payment-pending" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-amber-500/10 border border-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Wallet size={40} className="text-amber-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Awaiting Counter Payment</h1>
            <p className="text-brand-text-muted mb-8">
              Show your order ID at the counter and complete payment, or pay online now with Razorpay. Your order will join the kitchen queue after payment is confirmed.
            </p>
          </motion.div>
        )}

        {isQueuePending && (
          <motion.div key="pending" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-orange-500/10 border border-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Users size={40} className="text-orange-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Order Placed!</h1>
            <p className="text-brand-text-muted mb-8">Your order is in queue. Waiting for chef to accept.</p>
          </motion.div>
        )}

        {isDelivered && (
          <motion.div key="delivered" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <EnjoyFoodCelebration isPickup={isPickup} />
          </motion.div>
        )}

        {isOutForDelivery && (
          <motion.div key="out-for-delivery" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-sky-500/10 border border-sky-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Truck size={40} className="text-sky-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Out for Delivery!</h1>
            <p className="text-brand-text-muted mb-8">
              Our delivery partner is on the way with your waffles.
            </p>
          </motion.div>
        )}

        {isConfirmed && (
          <motion.div key="confirmed" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-emerald-500/10 border border-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <CheckCircle size={40} className="text-emerald-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Order Confirmed!</h1>
            <p className="text-brand-text-muted mb-8">
              {isPickup
                ? 'Your waffles are being prepared. We will notify you when ready.'
                : 'Your waffles are being prepared and will be delivered soon.'}
            </p>
          </motion.div>
        )}

        {isCancelled && (
          <motion.div key="cancelled" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-red-500/10 border border-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <XCircle size={40} className="text-red-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Order Cancelled</h1>
            <p className="text-brand-text-muted mb-8">This order was cancelled by the restaurant.</p>
          </motion.div>
        )}

        {isExpired && (
          <motion.div key="expired" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-20 h-20 bg-orange-500/10 border border-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Clock size={40} className="text-orange-400" />
            </motion.div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white mb-2">Order Expired</h1>
            <p className="text-brand-text-muted mb-8">The restaurant could not confirm in time</p>
          </motion.div>
        )}
        </AnimatePresence>

        <div className="rounded-2xl border p-6 mb-6 animate-scale-in bg-brand-surface border-brand-border">
          {isPickup && !isExpired && !isCancelled && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <Store size={16} className="text-brand-gold" />
              <span className="text-[14px] font-bold text-brand-gold uppercase tracking-wider">{serviceModeLabel} Order</span>
            </div>
          )}

          {!isPickup && !isExpired && !isCancelled && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <Truck size={16} className="text-sky-400" />
              <span className="text-[14px] font-bold text-sky-400 uppercase tracking-wider">Delivery Order</span>
            </div>
          )}

          <p className="text-[12px] font-semibold text-brand-text-dim uppercase tracking-wider mb-2">
            {isPickup && !isOnlinePaymentPending ? 'Show this at the counter' : 'Order ID'}
          </p>
          <div className="flex items-center justify-center gap-3">
            <span className={`font-black tracking-wider tabular-nums ${
              isPickup ? 'text-4xl text-brand-gold' : 'text-3xl text-white'
            }`}>
              {order.order_id}
            </span>
            <button onClick={copyOrderId} className="p-2 hover:bg-brand-surface-light/70 rounded-xl transition-colors text-brand-text-dim hover:text-brand-text-muted">
              <Copy size={18} strokeWidth={2.2} />
            </button>
          </div>

          {isCounterPaymentPendingBeforeAcceptance && (
            <div className="mt-4 flex items-center justify-center gap-2 bg-amber-500/10 rounded-2xl px-4 py-3 border border-amber-500/20">
              <Wallet size={16} className="text-amber-400" />
              <span className="text-[14px] font-bold text-amber-400">Payment pending at the counter.</span>
            </div>
          )}

          {isCounterPaymentPendingAfterAcceptance && (
            <div className="mt-4 flex items-center justify-center gap-2 bg-amber-500/10 rounded-2xl px-4 py-3 border border-amber-500/20">
              <ChefHat size={16} className="text-amber-400" />
              <span className="text-[14px] font-bold text-amber-400">Order accepted. Please wait while we prepare it.</span>
            </div>
          )}

          {isOnlinePaymentPending && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center justify-center gap-2 bg-sky-500/10 rounded-2xl px-4 py-3 border border-sky-500/20">
                <Clock size={16} className={reconcilingPayment ? 'text-sky-400 animate-spin' : 'text-sky-400'} />
                <span className="text-[14px] font-bold text-sky-400">
                  {reconcilingPayment ? 'Verifying payment...' : paymentCheckDelayed ? 'Confirmation delayed — tap below to retry' : 'Payment received. Confirming order...'}
                </span>
              </div>
              {paymentCheckDelayed && (
                <button
                  onClick={() => { void handleCheckPaymentAgain(); }}
                  className="w-full rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 text-[13px] font-bold py-2.5 hover:bg-sky-500/25 transition-colors"
                >
                  Check Payment Status
                </button>
              )}
              {canCancelOrder && !reconcilingPayment && !showCancelConfirm && (
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  className="w-full py-2.5 rounded-xl border border-rose-500/40 text-rose-400 text-[13px] font-medium hover:bg-rose-500/10 transition-colors"
                >
                  Cancel this order
                </button>
              )}
              {canCancelOrder && showCancelConfirm && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4">
                  <p className="text-sm font-semibold text-rose-300 mb-1">Cancel this order?</p>
                  <p className="text-xs text-brand-text-muted mb-4">If your payment went through, you may not receive a refund. Only cancel if you are sure the payment did not complete.</p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowCancelConfirm(false)}
                      disabled={cancellingOrder}
                      className="flex-1 py-2.5 rounded-xl border border-white/15 text-sm font-medium text-brand-text-muted hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                      Go back
                    </button>
                    <button
                      onClick={() => { void handleCancelOrder(); }}
                      disabled={cancellingOrder}
                      className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {cancellingOrder && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                      {cancellingOrder ? 'Cancelling...' : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {isQueuePending && (
            <div className="mt-4 flex items-center justify-center gap-2 bg-orange-500/10 rounded-2xl px-4 py-3 border border-orange-500/20">
              <Users size={16} className="text-orange-400" />
              <span className="text-[14px] font-bold text-orange-400">Your order is now in queue.</span>
            </div>
          )}

          {isPreparing && order.estimated_minutes && (
            <div className="mt-4 flex items-center justify-center gap-2 bg-amber-500/10 rounded-2xl px-4 py-3 border border-amber-500/20">
              <ChefHat size={16} className="text-amber-400" />
              <span className="text-[14px] font-bold tabular-nums text-amber-400">
                Preparing - ~{order.estimated_minutes} min
              </span>
            </div>
          )}

          {isPickupReady && (
            <div className="mt-4 bg-emerald-500/10 rounded-2xl px-4 py-3 border border-emerald-500/20 animate-pulse">
              <p className="text-[14px] text-emerald-400 font-bold flex items-center justify-center gap-2">
                <Bell size={16} />
                Your order is complete! {readyOrderLabel}
              </p>
            </div>
          )}

          {isDeliveryPacked && (
            <div className="mt-4 bg-sky-500/10 rounded-2xl px-4 py-3 border border-sky-500/20">
              <p className="text-[14px] text-sky-400 font-semibold flex items-center justify-center gap-2">
                <Package size={16} />
                Your order is packed and dispatching soon.
              </p>
            </div>
          )}

          {isCounterPaymentPendingBeforeAcceptance && (
            <div className="mt-4 bg-amber-500/5 rounded-2xl px-4 py-3">
              <p className="text-[14px] text-brand-text-muted font-semibold">
                Tell the staff your order ID and complete payment at the counter, or use the online payment option below. Your order will move to the queue once payment is confirmed.
              </p>
            </div>
          )}

          {isCounterPaymentPendingAfterAcceptance && (
            <div className="mt-4 bg-amber-500/5 rounded-2xl px-4 py-3">
              <p className="text-[14px] text-brand-text-muted font-semibold">
                Your order has already been accepted. Payment will be collected at the counter while your food is being prepared.
              </p>
            </div>
          )}

          {isOnlinePaymentPending && (
            <div className="mt-4 bg-sky-500/5 rounded-2xl px-4 py-3">
              <p className="text-[14px] text-brand-text-muted font-semibold">
                We are confirming your Razorpay payment before moving this order into the kitchen queue.
              </p>
            </div>
          )}

          {isQueuePending && (
            <div className="mt-4 bg-orange-500/5 rounded-2xl px-4 py-3">
              <p className="text-[14px] text-brand-text-muted font-semibold">
                Please wait in queue. Your order will be prepared soon. Thanks for your patience.
              </p>
            </div>
          )}

          {isPreparing && (
            <div className="mt-4 bg-amber-500/5 rounded-2xl px-4 py-3">
              <p className="text-[14px] text-brand-text-muted font-semibold">
                Sit back and relax! Your food is being freshly prepared.
              </p>
            </div>
          )}

          {!isPickup && isOutForDelivery && (
            <div className="mt-4 bg-sky-500/10 rounded-2xl px-4 py-3 border border-sky-500/20">
              <p className="text-[14px] text-sky-400 font-semibold">
                Our delivery partner is on the way with your waffles!
              </p>
            </div>
          )}

          {(isCounterPaymentPendingBeforeAcceptance || (order.order_type === 'delivery' && order.payment_method === 'cod' && order.payment_status !== 'paid')) && !isDelivered && !isExpired && !isCancelled && (
            <PaymentInstructionCard order={order} onPayOnline={isCounterPaymentPendingBeforeAcceptance ? handlePayOnlineNow : undefined} payingOnline={payingOnline} />
          )}

          <div className="mt-6 pt-4 border-t border-brand-border text-[14px] text-brand-text-muted">
            <div className="flex justify-between mb-1">
              <span>Total</span>
              <span className="font-bold text-brand-gold tabular-nums">{'\u20B9'}{order.total}</span>
            </div>
            <div className="flex justify-between">
              <span>Service</span>
              <span className="capitalize text-white">{serviceModeLabel}</span>
            </div>
            <div className="flex justify-between mt-1">
              <span>Payment</span>
              <span className="capitalize text-white">
                {getPaymentMethodLabel(order)}
              </span>
            </div>
          </div>

          {order.customer_email && (
            <div className="mt-4 rounded-2xl border border-brand-gold/20 bg-brand-gold/5 px-4 py-3 text-left">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-text-dim">
                Order Emails
              </p>
              <p className="mt-1 text-[12px] text-brand-text-dim">
                Payment receipt and order updates will be sent here
              </p>
              <p className="mt-1 break-all text-[14px] font-semibold text-white">
                {order.customer_email}
              </p>
            </div>
          )}
        </div>

        {showSpecials && specials.length > 0 && (
          <SpecialsSuggestions items={specials} onViewMenu={() => navigate('/menu')} />
        )}

        <div className="flex flex-col gap-3">
          {user && !isDelivered && !isCancelled && !isExpired && (
            <Link to={`/track/${order.order_id}`} className="btn-primary w-full text-center">
              Track Order
            </Link>
          )}
          {(isExpired || isCancelled) && (
            <Link to="/menu" className="btn-primary w-full text-center flex items-center justify-center gap-2">
              <RotateCcw size={18} strokeWidth={2.2} />
              Order Again
            </Link>
          )}
          <Link to="/menu" className="btn-outline w-full text-center">
            {isDelivered ? 'Order More' : 'Back to Menu'}
          </Link>
        </div>
      </motion.div>
    </div>
  );
}

function PickupReadyBanner({ order }: { order: Order }) {
  const [pulse, setPulse] = useState(true);
  const readyOrderLabel = getReadyOrderLabel(order);
  const serviceModeLabel = getServiceModeLabel(order);

  useEffect(() => {
    const timer = setTimeout(() => setPulse(false), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`relative overflow-hidden rounded-3xl mb-8 transition-all duration-500 ${
      pulse ? 'ring-4 ring-emerald-400/40 shadow-[0_0_40px_rgba(16,185,129,0.2)]' : ''
    }`}>
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500 to-emerald-600" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_80%,rgba(255,255,255,0.15),transparent)]" />
      <div className="relative px-6 py-8">
        <div className={`mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-brand-surface-strong/80 backdrop-blur-sm ${
          pulse ? 'animate-bounce' : ''
        }`}>
          <Bell size={40} className="text-white" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2 tracking-tight">
          {readyOrderLabel}!
        </h1>
        <p className="text-emerald-100 text-[15px] font-medium mb-4">
          Show this order ID <span className="font-black">{order.order_id}</span> at the counter for your {serviceModeLabel.toLowerCase()} order
        </p>
        <div className="inline-flex items-center gap-2 bg-brand-surface-strong/80 backdrop-blur-sm rounded-full px-5 py-2.5 text-white text-[13px] font-bold">
          <Sparkles size={14} />
          Freshly made and ready now
        </div>
      </div>
    </div>
  );
}

function EnjoyFoodCelebration({ isPickup }: { isPickup: boolean }) {
  const [showParticles, setShowParticles] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowParticles(false), 4000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="relative mb-8">
      {showParticles && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full animate-confetti"
              style={{
                left: `${Math.random() * 100}%`,
                top: `-10%`,
                backgroundColor: ['#FFD700', '#FF6B35', '#10B981', '#F59E0B', '#3B82F6', '#EC4899'][i % 6],
                animationDelay: `${Math.random() * 2}s`,
                animationDuration: `${2 + Math.random() * 2}s`,
              }}
            />
          ))}
        </div>
      )}

      <div className="relative">
        <div className="w-24 h-24 bg-gradient-to-br from-brand-gold/20 to-brand-gold/5 border-2 border-brand-gold/30 rounded-full flex items-center justify-center mx-auto mb-6 animate-scale-in">
          <CheckCircle size={48} className="text-brand-gold" />
        </div>
        <h1 className="text-3xl font-black tracking-tight text-white mb-3">
          {isPickup ? 'Enjoy Your Food!' : 'Order Delivered!'}
        </h1>
        <p className="text-brand-text-muted text-[15px] mb-2">
          {isPickup
            ? 'Thank you for dining with us. We hope you love every bite!'
            : 'Your waffles have arrived. Enjoy every bite!'}
        </p>
        <div className="inline-flex items-center gap-2 mt-2 bg-brand-gold/10 border border-brand-gold/20 rounded-full px-5 py-2 text-brand-gold text-[13px] font-bold">
          <Star size={14} fill="currentColor" />
          We'd love to see you again soon!
        </div>
      </div>
    </div>
  );
}

function SpecialsSuggestions({ items, onViewMenu }: { items: MenuItem[]; onViewMenu: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-brand-gold/15 bg-gradient-to-b from-brand-gold/[0.04] to-transparent p-5 mb-6 text-left"
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-brand-gold/10 rounded-lg flex items-center justify-center">
          <Sparkles size={16} className="text-brand-gold" />
        </div>
        <div>
          <h3 className="text-[14px] font-bold text-white">Today's Top Picks</h3>
          <p className="text-[12px] text-brand-text-dim font-medium">Craving more? Try these favorites</p>
        </div>
      </div>

      <motion.div
        className="grid grid-cols-3 gap-2.5 mb-4"
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
      >
        {items.slice(0, 3).map((item) => (
          <motion.div key={item.id} variants={staggerChild}>
            <Link
              to="/menu"
              className="group rounded-xl overflow-hidden border border-brand-border bg-brand-surface hover:border-brand-gold/30 transition-all block"
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
          </motion.div>
        ))}
      </motion.div>

      {items.length > 3 && (
        <div className="grid grid-cols-1 gap-2 mb-4">
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

      <button
        onClick={onViewMenu}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-brand-gold/10 border border-brand-gold/20 text-brand-gold text-[13px] font-bold hover:bg-brand-gold/15 transition-all"
      >
        View Full Menu
        <ArrowRight size={14} />
      </button>
    </motion.div>
  );
}

function PaymentInstructionCard({
  order,
  onPayOnline,
  payingOnline = false,
}: {
  order: Order;
  onPayOnline?: () => void;
  payingOnline?: boolean;
}) {
  const isPickup = order.order_type === 'pickup';
  const instructionHeading = getPendingPaymentLabel(order);
  const paymentLine = isPickup
    ? 'Show this order ID at the counter to confirm your order'
    : 'Pay the delivery partner when your order arrives';
  const footerLine = isPickup
    ? 'Your order will enter the queue after staff confirms payment'
    : 'Please keep exact change ready';

  return (
    <div className="mt-4 rounded-2xl border-2 border-brand-gold/30 bg-brand-gold/[0.04] p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 bg-brand-gold/15 rounded-lg flex items-center justify-center">
          <Wallet size={16} className="text-brand-gold" />
        </div>
        <div>
          <h4 className="text-[17px] font-extrabold text-white tracking-tight">{instructionHeading}</h4>
          <p className="text-[12px] font-semibold text-brand-text-muted">{paymentLine}</p>
        </div>
      </div>
      <div className="bg-brand-bg/60 rounded-xl px-4 py-3 flex items-center justify-between">
        <span className="text-[13px] text-brand-text-muted font-medium">Amount to Pay</span>
        <span className="text-2xl font-black text-brand-gold tabular-nums">{'\u20B9'}{order.total}</span>
      </div>
      {isPickup && (
        <div className="mt-3 text-center">
          <p className="text-[20px] font-black tracking-tight text-white">
            PAY CASH AT COUNTER
          </p>
          {onPayOnline && (
            <p className="mt-2 text-[12px] font-black uppercase tracking-[0.35em] text-brand-text-dim">
              OR
            </p>
          )}
        </div>
      )}
      {onPayOnline && (
        <button
          onClick={onPayOnline}
          disabled={payingOnline}
          className="mt-3 w-full rounded-xl bg-brand-gold px-4 py-3.5 text-[14px] font-black text-brand-bg transition-colors hover:bg-brand-gold-soft disabled:cursor-not-allowed disabled:opacity-60"
        >
          {payingOnline ? 'Opening UPI Payment...' : 'Pay via UPI'}
        </button>
      )}
      {!onPayOnline && (
        <p className="text-[12px] font-semibold text-brand-text-dim mt-2.5 text-center">
          {footerLine}
        </p>
      )}
    </div>
  );
}
