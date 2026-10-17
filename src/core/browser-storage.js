let configuredStorage;

export function setBrowserStorage(storage) {
  configuredStorage = storage;
}

export function browserStorage() {
  return configuredStorage || globalThis.localStorage;
}
