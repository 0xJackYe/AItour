import { importLibrary, setOptions } from '@googlemaps/js-api-loader';

let configPromise = null;
let loadPromise = null;
let optionsSet = false;

/** 运行时从后端获取浏览器端配置，同一份构建产物可部署到不同环境。 */
export function fetchClientConfig() {
  configPromise ||= fetch('/api/config')
    .then((response) => {
      if (!response.ok) throw new Error(`配置加载失败（${response.status}）`);
      return response.json();
    })
    .catch((error) => {
      configPromise = null;
      throw error;
    });
  return configPromise;
}

export function loadGoogleMaps() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const config = await fetchClientConfig();
    const key = config?.maps?.browserKey;
    if (!key) {
      const error = new Error('服务端未配置 Google Maps Key');
      error.code = 'MAPS_NOT_CONFIGURED';
      throw error;
    }
    // HMR 会保留已加载的 Google Maps，但会重新执行本模块。
    if (!optionsSet && !window.google?.maps?.importLibrary) {
      setOptions({ key, v: 'weekly', language: 'zh-CN' });
    }
    optionsSet = true;
    const [, markerLibrary] = await Promise.all([importLibrary('maps'), importLibrary('marker')]);
    return {
      maps: window.google.maps,
      AdvancedMarkerElement: markerLibrary.AdvancedMarkerElement,
      PinElement: markerLibrary.PinElement,
      mapId: config.maps.mapId || 'DEMO_MAP_ID',
    };
  })().catch((error) => {
    // 失败不缓存，允许稍后重试（例如网络恢复后）。
    loadPromise = null;
    throw error;
  });
  return loadPromise;
}
