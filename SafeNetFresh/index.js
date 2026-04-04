// Order matters: gesture handler first (React Navigation), then Expo entry.
// Do not import react-native-reanimated here — it touches native JSI too early and causes
// "Exception in HostFunction" / "main has not been registered" in Expo Go + Hermes.
import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
