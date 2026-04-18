# SafeNet Production Implementation Guide

## ✅ NEWLY IMPLEMENTED

### 1. GPS-Based Zone Detection
**File:** `hooks/useGPSZoneDetection.js`
**Status:** Ready to integrate

**Usage in ProfileSetupScreen.js (Step 3):**
```javascript
import { useGPSZoneDetection } from '../hooks/useGPSZoneDetection';

// In component:
const { detectZone, gpsLoading, gpsError } = useGPSZoneDetection();

// Add button in Step 3:
<TouchableOpacity 
  onPress={async () => {
    const detected = await detectZone(ZONES);
    if (detected) setZone(detected);
  }}
  disabled={gpsLoading}
>
  <Text>{gpsLoading ? 'Detecting...' : 'Detect my zone'}</Text>
</TouchableOpacity>

{gpsError ? <Text style={styles.error}>{gpsError}</Text> : null}
```

**Dependencies needed:**
```bash
npm install expo-location
```

---

### 2. Multilingual Support
**Files:** 
- `locales/en.json` ✅
- `locales/hi.json` ✅
- `locales/te.json` ✅
- `contexts/LocalizationContext.js` ✅

**Setup in App.js:**
```javascript
import { LocalizationProvider } from './contexts/LocalizationContext';

export default function App() {
  return (
    <LocalizationProvider>
      {/* rest of app */}
    </LocalizationProvider>
  );
}
```

**Usage in any screen:**
```javascript
import { useLocalization } from '../contexts/LocalizationContext';

export default function MyScreen() {
  const { t, language, setLanguage } = useLocalization();
  
  return (
    <View>
      <Text>{t('dashboard.title')}</Text>
      <TouchableOpacity onPress={() => setLanguage('hi')}>
        <Text>हिंदी</Text>
      </TouchableOpacity>
    </View>
  );
}
```

**Dependencies needed:**
```bash
npm install expo-localization
```

---

## 🔄 NEXT STEPS - PRIORITY ORDER

### Phase 1: Payment Integration (Critical)

#### 1. Install Razorpay
```bash
npm install @react-native-razorpay/razorpay
```

#### 2. Add to ProfileSetupScreen.js (Step 5)
```javascript
import RazorpayCheckout from '@react-native-razorpay/razorpay';
import { payments } from '../services/api';

const handlePayment = async () => {
  try {
    setLoading(true);
    
    // Create order
    const order = await payments.createPremiumOrder(tier);
    
    // Open Razorpay
    const options = {
      key: 'rzp_live_YOUR_KEY_HERE', // Get from Razorpay dashboard
      order_id: order.id,
      amount: order.amount,
      currency: 'INR',
      name: 'SafeNet',
      description: `${tier} Coverage - ₹${selectedTier.weekly}/week`,
      prefill: {
        contact: phone,
        email: 'worker@safenet.app',
      },
      theme: { color: '#1A56DB' },
    };

    RazorpayCheckout.open(options)
      .then(async (data) => {
        // Verify payment
        const verified = await payments.verifyPremium(
          data.razorpay_order_id,
          data.razorpay_payment_id,
          data.razorpay_signature
        );
        
        if (verified.success) {
          setSuccessPolicy(verified);
          setStep(6);
        }
      })
      .catch((error) => {
        Alert.alert('Payment failed', error.description);
      });
  } catch (e) {
    Alert.alert('Error', formatApiError(e));
  } finally {
    setLoading(false);
  }
};
```

---

### Phase 2: Error Handling & Loading States

#### 1. Create Skeleton Loader Component
**File:** `components/SkeletonLoader.js`
```javascript
import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';

export function SkeletonLoader({ width = '100%', height = 20, style }) {
  const opacity = React.useRef(new Animated.Value(0.3)).current;

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    ).start();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.skeleton,
        { width, height, opacity },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
  },
});
```

#### 2. Add to DashboardScreen.js
```javascript
{zoneStatusQuery.isLoading ? (
  <View style={styles.skeletonWrap}>
    <SkeletonLoader height={60} style={{ marginBottom: 12 }} />
    <SkeletonLoader height={40} style={{ marginBottom: 12 }} />
    <SkeletonLoader height={40} />
  </View>
) : (
  // existing content
)}
```

---

### Phase 3: Empty States

#### 1. Add to ClaimsScreen.js
```javascript
{list.length === 0 ? (
  <View style={styles.emptyState}>
    <Text style={styles.emptyIcon}>📋</Text>
    <Text style={styles.emptyTitle}>No claims yet</Text>
    <Text style={styles.emptyText}>
      Run a simulation from Home to see how SafeNet works
    </Text>
  </View>
) : (
  // existing list
)}
```

#### 2. Add to DashboardScreen.js
```javascript
{payouts.length === 0 ? (
  <View style={styles.emptyPayouts}>
    <Text style={styles.emptyIcon}>💰</Text>
    <Text style={styles.emptyText}>No disruptions yet — you're all set ✅</Text>
  </View>
) : (
  // existing payouts
)}
```

---

### Phase 4: Network Error Handling

#### 1. Create Error Boundary
**File:** `components/ErrorBoundary.js`
```javascript
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>{this.state.error?.message}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ hasError: false })}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 18, fontWeight: '800', marginBottom: 8 },
  message: { fontSize: 14, color: '#666', marginBottom: 16, textAlign: 'center' },
  button: { backgroundColor: '#1A56DB', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  buttonText: { color: '#fff', fontWeight: '700' },
});
```

---

## 📋 INTEGRATION CHECKLIST

### Before Production:

- [ ] GPS detection working on real device
- [ ] Razorpay payment flow tested
- [ ] Multilingual switching tested
- [ ] Error states display correctly
- [ ] Loading states show for all API calls
- [ ] Empty states for no data
- [ ] Network error handling
- [ ] Token refresh on 401
- [ ] Logout on unauthorized
- [ ] Pull-to-refresh working
- [ ] WebSocket reconnection
- [ ] All API endpoints verified
- [ ] Error messages user-friendly
- [ ] No console.logs in production
- [ ] Performance optimized
- [ ] Accessibility tested

---

## 🔑 ENVIRONMENT VARIABLES

Create `.env` file:
```
EXPO_PUBLIC_BACKEND_URL=https://safenet-api-y4se.onrender.com
EXPO_PUBLIC_RAZORPAY_KEY=rzp_live_YOUR_KEY
EXPO_PUBLIC_DEMO_MODE=false
```

---

## 📱 TESTING CHECKLIST

### Manual Testing:
1. **Onboarding Flow**
   - [ ] OTP send/verify
   - [ ] GPS detection (allow/deny)
   - [ ] Zone selection
   - [ ] Platform selection
   - [ ] Hours selection
   - [ ] Tier selection
   - [ ] Payment flow
   - [ ] Success screen

2. **Dashboard**
   - [ ] Data loads
   - [ ] Pull-to-refresh
   - [ ] Real-time updates
   - [ ] Disruption banner shows

3. **Claims**
   - [ ] History loads
   - [ ] Status colors correct
   - [ ] Breakdown displays
   - [ ] Modal opens

4. **Policy**
   - [ ] Current policy shows
   - [ ] Premium breakdown displays
   - [ ] Plan change works

5. **Error Scenarios**
   - [ ] Network down
   - [ ] Timeout
   - [ ] 401 Unauthorized
   - [ ] 404 Not found
   - [ ] 500 Server error

---

## 🚀 DEPLOYMENT

### Before deploying to production:

1. **Build for iOS:**
   ```bash
   eas build --platform ios --auto-submit
   ```

2. **Build for Android:**
   ```bash
   eas build --platform android --auto-submit
   ```

3. **Update app.json:**
   ```json
   {
     "expo": {
       "version": "1.0.0",
       "extra": {
         "BACKEND_URL": "https://safenet-api-y4se.onrender.com",
         "RAZORPAY_KEY": "rzp_live_...",
         "DEMO_MODE": false
       }
     }
   }
   ```

4. **Test on real devices**

5. **Submit to app stores**

---

## 📞 SUPPORT

For issues:
1. Check API logs: `https://safenet-api-y4se.onrender.com/health`
2. Check device logs: `expo logs`
3. Check network tab in DevTools
4. Verify environment variables
5. Check token expiry
