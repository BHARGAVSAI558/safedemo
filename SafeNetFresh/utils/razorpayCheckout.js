import { Platform } from 'react-native';

const RZP_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpayScript() {
  if (Platform.OS !== 'web') return Promise.reject(new Error('razorpay_web_only'));
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('razorpay_no_window'));
  }
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = RZP_SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('razorpay_script_load_failed'));
    document.body.appendChild(s);
  });
}

/**
 * Razorpay Standard Checkout (web). Resolves with payment id + signature for /payments/premium/verify.
 */
export async function openRazorpayWebCheckout({
  keyId,
  orderId,
  amountPaise,
  currency = 'INR',
  name = 'SafeNet',
  description = 'Weekly premium',
  prefill = {},
  theme = { color: '#2563eb' },
}) {
  await loadRazorpayScript();
  return new Promise((resolve, reject) => {
    const options = {
      key: keyId,
      amount: amountPaise,
      currency,
      name,
      description,
      order_id: orderId,
      prefill,
      theme,
      handler(response) {
        resolve({
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
      },
      modal: {
        ondismiss() {
          reject(new Error('checkout_dismissed'));
        },
      },
    };
    try {
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (e) {
      reject(e);
    }
  });
}
