module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Do not add react-native-reanimated/plugin here — babel-preset-expo injects it when the package is installed.
    // A duplicate plugin causes "Exception in HostFunction" / runtime not ready in Expo Go.
    plugins: [],
  };
};
