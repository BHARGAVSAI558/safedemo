# SafeNet Expo App - Production Readiness Checklist

## STATUS: PARTIAL IMPLEMENTATION

### ✅ COMPLETED

#### API Service (api.js)
- [x] Centralized API wrapper with axios
- [x] Content-Type header set
- [x] Try/catch error handling
- [x] JWT token management
- [x] Retry logic for 502/503/504
- [x] formatApiError() for user-facing messages
- [x] All endpoints defined (auth, workers, policies, claims, zones, payments, support)

#### Authentication Flow
- [x] OTP send/verify (auth.sendOTP, auth.verifyOTP)
- [x] Token storage and refresh
- [x] Demo mode OTP auto-fill
- [x] Session expiry handling

#### Onboarding (ProfileSetupScreen.js)
- [x] Step 1: Name input
- [x] Step 2: Platform selection (Zomato/Swiggy/Other)
- [x] Step 3: Zone selection (hardcoded ZONES array)
- [x] Step 4: Working hours preset
- [x] Step 5: Coverage tier selection
- [x] Step 6: Success confirmation
- [x] Policy activation via API
- [x] Premium calculation display

#### Dashboard (DashboardScreen.js)
- [x] Coverage status display
- [x] Zone status with weather/AQI
- [x] Earnings DNA heatmap
- [x] Weekly protection ring
- [x] Recent payouts
- [x] Active claim progress
- [x] Forecast Shield display
- [x] Pull-to-refresh
- [x] WebSocket real-time updates

#### Claims (ClaimsScreen.js)
- [x] Active disruptions display
- [x] Claim history with status
- [x] Payout breakdown display
- [x] Status color coding (green/yellow/red)
- [x] Modal for payment details

#### Policy (PolicyScreen.js)
- [x] Current policy display
- [x] Premium breakdown formula
- [x] Risk score visualization
- [x] Plan change functionality
- [x] Weather outlook (14 days)

---

### ❌ MISSING / INCOMPLETE

#### 1. GPS-Based Zone Detection
**Status:** NOT IMPLEMENTED
**Required:**
- [ ] expo-location permission request
- [ ] Get device GPS coordinates (lat/lng)
- [ ] Call `zones.detectFromGPS(lat, lng)` API
- [ ] Auto-populate zone in onboarding
- [ ] Handle permission denied gracefully
- [ ] Show detected zone with confidence

**Files to modify:**
- ProfileSetupScreen.js (Step 3 - add GPS detection button)
- services/api.js (already has zones.detectFromGPS)

**Implementation:**
```javascript
// In ProfileSetupScreen.js, Step 3
const detectZoneFromGPS = async () => {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('Permission denied', 'Enable location to auto-detect your zone');
    return;
  }
  const location = await Location.getCurrentPositionAsync({});
  const detected = await zones.detectFromGPS(location.coords.latitude, location.coords.longitude);
  setZone(detected);
};
```

---

#### 2. Razorpay Payment Integration
**Status:** NOT IMPLEMENTED
**Required:**
- [ ] Install @react-native-razorpay/razorpay
- [ ] Create premium order via API
- [ ] Open Razorpay checkout
- [ ] Verify payment signature
- [ ] Handle success/failure
- [ ] Show payment status

**Files to modify:**
- ProfileSetupScreen.js (Step 5 - add payment flow)
- services/api.js (already has payments.createPremiumOrder, payments.verifyPremium)

**Implementation:**
```javascript
// In ProfileSetupScreen.js, Step 5
const handlePayment = async () => {
  const order = await payments.createPremiumOrder(tier);
  RazorpayCheckout.open({
    key: 'rzp_live_...',
    order_id: order.id,
    amount: order.amount,
    currency: 'INR',
    name: 'SafeNet',
    description: `${tier} Coverage`,
    prefill: { contact: phone },
  });
};
```

---

#### 3. Multilingual Support
**Status:** NOT IMPLEMENTED
**Required:**
- [ ] Install expo-localization
- [ ] Create translation files (en, hi, te)
- [ ] Implement i18n context
- [ ] Translate all UI strings
- [ ] Language switcher in settings

**Files to create:**
- locales/en.json
- locales/hi.json
- locales/te.json
- contexts/LocalizationContext.js

**Minimal translations needed:**
- Onboarding steps
- Dashboard labels
- Claims status
- Error messages
- Button labels

---

#### 4. Loading States & Error Handling
**Status:** PARTIAL
**Missing:**
- [ ] Skeleton loaders for dashboard
- [ ] Retry buttons on error states
- [ ] Empty state illustrations
- [ ] Network error detection
- [ ] Timeout handling

**Files to modify:**
- DashboardScreen.js (add skeleton loaders)
- ClaimsScreen.js (add empty state)
- PolicyScreen.js (add error retry)

---

#### 5. Real Data Integration
**Status:** PARTIAL
**Missing:**
- [ ] Dashboard: Replace mock zone data with API
- [ ] Dashboard: Real earnings DNA from API
- [ ] Dashboard: Real disruptions from /claims/active
- [ ] Claims: Real claim history from API
- [ ] Policy: Real premium breakdown from API

**Current Issues:**
- ProfileSetupScreen uses hardcoded ZONES array
- DashboardScreen has some mock data
- Need to ensure all queries use correct API endpoints

---

#### 6. Production Checklist
**Status:** NOT STARTED
- [ ] Remove console.logs in production
- [ ] Add error tracking (Sentry)
- [ ] Add analytics (Mixpanel/Firebase)
- [ ] Implement rate limiting
- [ ] Add request timeouts
- [ ] Secure token storage
- [ ] Add app versioning
- [ ] Test on real devices
- [ ] Performance optimization
- [ ] Accessibility audit

---

## PRIORITY IMPLEMENTATION ORDER

### Phase 1 (Critical - Week 1)
1. GPS-based zone detection
2. Razorpay payment integration
3. Fix hardcoded ZONES → API-driven zones
4. Add loading skeletons

### Phase 2 (Important - Week 2)
1. Multilingual support (English + Hindi)
2. Error handling & retry logic
3. Empty states
4. Network error detection

### Phase 3 (Nice-to-have - Week 3)
1. Analytics integration
2. Error tracking (Sentry)
3. Performance optimization
4. Accessibility improvements

---

## API ENDPOINTS VERIFICATION

### ✅ Implemented in api.js
- POST /auth/send-otp
- POST /auth/verify-otp
- GET /workers/me
- POST /workers/create
- PUT /workers/update
- GET /workers/earnings-dna
- GET /policies/current
- POST /policies/activate
- GET /claims/active
- GET /claims/history
- POST /zones/detect
- GET /zones/{id}/forecast-shield
- POST /payments/premium/order
- POST /payments/premium/verify
- POST /support/query

### ⚠️ Need Verification
- Do all endpoints return expected data structure?
- Are error responses consistent?
- Do all endpoints require authentication?
- Are rate limits documented?

---

## TESTING CHECKLIST

- [ ] OTP flow end-to-end
- [ ] Onboarding with GPS detection
- [ ] Payment flow with Razorpay
- [ ] Dashboard data loading
- [ ] Claims history display
- [ ] Policy activation
- [ ] Error handling (network down, timeout, 401, 404, 500)
- [ ] Multilingual switching
- [ ] Pull-to-refresh
- [ ] WebSocket reconnection
- [ ] Token refresh on expiry
- [ ] Offline mode (if applicable)

---

## NOTES

- Backend is at: https://safenet-api-y4se.onrender.com
- Demo mode enabled for testing
- All API calls wrapped in try/catch
- Token management handled automatically
- WebSocket connection for real-time updates
