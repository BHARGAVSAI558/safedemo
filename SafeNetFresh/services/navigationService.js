import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

export function navigate(name, params) {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate(name, params);
  return true;
}

