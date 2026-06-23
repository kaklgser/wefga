import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CartProvider, useCart } from './contexts/CartContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SiteSettingsProvider } from './contexts/SiteSettingsContext';
import { ToastProvider, useToast } from './components/Toast';
import Header from './components/Header';
import Footer from './components/Footer';
import BottomNav from './components/BottomNav';
import FloatingCart from './components/FloatingCart';
import RainEffect from './components/RainEffect';
import SiteClosedOverlay from './components/SiteClosedOverlay';
import RouteSeo from './components/RouteSeo';
import Home from './pages/Home';
import Menu from './pages/Menu';
import Cart from './pages/Cart';
import Offers from './pages/Offers';
import OrderSuccess from './pages/OrderSuccess';
import TrackOrder from './pages/TrackOrder';
import About from './pages/About';
import Contact from './pages/Contact';
import AuthPage from './pages/AuthPage';
import MyOrders from './pages/MyOrders';
import Profile from './pages/Profile';
import PrivacyPolicy from './pages/PrivacyPolicy';
import TermsOfService from './pages/TermsOfService';
import AdminLogin from './pages/admin/AdminLogin';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminOrders from './pages/admin/AdminOrders';
import AdminMenu from './pages/admin/AdminMenu';
import AdminZones from './pages/admin/AdminZones';
import AdminOffers from './pages/admin/AdminOffers';
import AdminOffersBulk from './pages/admin/AdminOffersBulk';
import AdminMessages from './pages/admin/AdminMessages';
import AdminWebsite from './pages/admin/AdminWebsite';
import ChefLogin from './pages/chef/ChefLogin';
import ChefDashboard from './pages/chef/ChefDashboard';
import DeliveryLogin from './pages/delivery/DeliveryLogin';
import DeliveryDashboard from './pages/delivery/DeliveryDashboard';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useSiteSettings } from './hooks/useSiteSettings';
import { readPendingOnlineOrder, clearPendingOnlineOrder } from './lib/pendingOnlineOrder';
import { reconcileRazorpayPayment } from './lib/razorpay';
import { updateGuestOrderSnapshot } from './lib/guestOrderSnapshot';
import type { Order } from './types';

// Silently recovers a paid UPI order when the user returns to any page after
// closing their UPI app without waiting for the redirect back to the website.
function PendingPaymentRecovery() {
  const navigate = useNavigate();
  const { clearCart } = useCart();
  const { showToast } = useToast();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const pendingOrderId = readPendingOnlineOrder();
    if (!pendingOrderId) return;

    void (async () => {
      try {
        const result = await reconcileRazorpayPayment(pendingOrderId, undefined);

        if (result.paymentState === 'paid') {
          const updates: Partial<Order> = {
            payment_status: 'paid',
            payment_provider: 'razorpay',
            payment_verified_at: new Date().toISOString(),
            ...(result.paymentMethod ? { payment_method: result.paymentMethod as Order['payment_method'] } : {}),
            ...(result.orderStatus ? { status: result.orderStatus as Order['status'] } : {}),
          };
          updateGuestOrderSnapshot(pendingOrderId, updates);
          clearPendingOnlineOrder(pendingOrderId);
          clearCart();
          showToast('Your payment was confirmed — your order is placed!');
          navigate(`/order-success/${pendingOrderId}`, { replace: true });
        } else if (result.paymentState === 'failed') {
          clearPendingOnlineOrder(pendingOrderId);
          updateGuestOrderSnapshot(pendingOrderId, { payment_status: 'failed', status: 'expired' });
        }
        // paymentState === 'pending': leave sessionStorage entry; OrderSuccess will handle it
      } catch {
        // Network error — silently ignore; recovery will retry next page load
      }
    })();
  }, [clearCart, navigate, showToast]);

  return null;
}

function LoadingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-bg">
      <div className="w-8 h-8 border-4 border-brand-gold border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { user, profile, loading } = useAuth();
  if (loading) return <LoadingSpinner />;
  if (!user || !profile || profile.role !== 'admin') return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}

function ChefRoute({ children }: { children: ReactNode }) {
  const { user, profile, loading } = useAuth();
  if (loading) return <LoadingSpinner />;
  if (!user || !profile || (profile.role !== 'chef' && profile.role !== 'admin')) return <Navigate to="/chef/login" replace />;
  return <>{children}</>;
}

function DeliveryRoute({ children }: { children: ReactNode }) {
  const { user, profile, loading } = useAuth();
  if (loading) return <LoadingSpinner />;
  if (!user || !profile || (profile.role !== 'delivery' && profile.role !== 'admin')) return <Navigate to="/delivery/login" replace />;
  return <>{children}</>;
}

function CustomerAccessGate({ children }: { children: ReactNode }) {
  const { settings, loading } = useSiteSettings();

  return (
    <>
      {!loading && settings?.rain_enabled && <RainEffect />}
      {children}
      {!loading && settings && !settings.site_is_open && <SiteClosedOverlay settings={settings} />}
    </>
  );
}

function CustomerLayout({ children }: { children: ReactNode }) {
  const { profile, loading } = useAuth();

  if (!loading && profile) {
    if (profile.role === 'chef') return <Navigate to="/chef" replace />;
    if (profile.role === 'admin') return <Navigate to="/admin" replace />;
    if (profile.role === 'delivery') return <Navigate to="/delivery" replace />;
  }

  return (
    <CustomerAccessGate>
      <Header />
      <main className="customer-main">{children}</main>
      <FloatingCart />
      <Footer />
      <BottomNav />
    </CustomerAccessGate>
  );
}

function ScrollToTop() {
  const { pathname, search, hash } = useLocation();

  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return;

    const previousSetting = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';

    return () => {
      window.history.scrollRestoration = previousSetting;
    };
  }, []);

  useLayoutEffect(() => {
    if (hash) return;

    const resetScrollPosition = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    resetScrollPosition();
    const frameId = window.requestAnimationFrame(resetScrollPosition);

    return () => window.cancelAnimationFrame(frameId);
  }, [pathname, search, hash]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <RouteSeo />
      <SiteSettingsProvider>
        <AuthProvider>
          <CartProvider>
            <ToastProvider>
              <PendingPaymentRecovery />
              <Routes>
                <Route path="/chef/login" element={<ChefLogin />} />
                <Route path="/chef" element={<ChefRoute><ChefDashboard /></ChefRoute>} />
                <Route path="/delivery/login" element={<DeliveryLogin />} />
                <Route path="/delivery" element={<DeliveryRoute><DeliveryDashboard /></DeliveryRoute>} />
                <Route path="/admin/login" element={<AdminLogin />} />
                <Route
                  path="/admin/*"
                  element={
                    <AdminRoute>
                      <AdminLayout />
                    </AdminRoute>
                  }
                >
                  <Route index element={<AdminDashboard />} />
                  <Route path="orders" element={<AdminOrders />} />
                  <Route path="menu" element={<AdminMenu />} />
                  <Route path="zones" element={<AdminZones />} />
                  <Route path="offers/bulk" element={<AdminOffersBulk />} />
                  <Route path="offers" element={<AdminOffers />} />
                  <Route path="messages" element={<AdminMessages />} />
                  <Route path="website" element={<AdminWebsite />} />
                </Route>

                <Route path="/" element={<CustomerLayout><Home /></CustomerLayout>} />
                <Route path="/menu" element={<CustomerLayout><Menu /></CustomerLayout>} />
                <Route path="/offers" element={<CustomerLayout><Offers /></CustomerLayout>} />
                <Route path="/cart" element={<CustomerLayout><Cart /></CustomerLayout>} />
                <Route path="/order-success/:orderId" element={<CustomerLayout><OrderSuccess /></CustomerLayout>} />
                <Route path="/track" element={<CustomerLayout><TrackOrder /></CustomerLayout>} />
                <Route path="/track/:orderId" element={<CustomerLayout><TrackOrder /></CustomerLayout>} />
                <Route path="/about" element={<CustomerLayout><About /></CustomerLayout>} />
                <Route path="/contact" element={<CustomerLayout><Contact /></CustomerLayout>} />
                <Route path="/auth" element={<CustomerAccessGate><AuthPage /></CustomerAccessGate>} />
                <Route path="/profile" element={<CustomerLayout><Profile /></CustomerLayout>} />
                <Route path="/my-orders" element={<CustomerLayout><MyOrders /></CustomerLayout>} />
                <Route path="/privacy" element={<CustomerLayout><PrivacyPolicy /></CustomerLayout>} />
                <Route path="/terms" element={<CustomerLayout><TermsOfService /></CustomerLayout>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ToastProvider>
          </CartProvider>
        </AuthProvider>
      </SiteSettingsProvider>
    </BrowserRouter>
  );
}
