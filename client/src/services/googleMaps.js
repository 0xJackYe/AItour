import { setOptions, importLibrary } from '@googlemaps/js-api-loader';

let configured = false;
let loadPromise = null;

export function loadGoogleMaps() {
  if (loadPromise) return loadPromise;

  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) return Promise.reject(new Error('未配置 Google Maps 浏览器 Key'));

  // HMR 会保留已经加载到 window 的 Google Maps，但重新执行本模块。
  // 只有 API 尚未初始化时才调用 setOptions，避免重复配置和控制台警告。
  if (!configured && !window.google?.maps?.importLibrary) {
    setOptions({ key, v: 'weekly', language: 'zh-CN' });
  }
  configured = true;

  loadPromise = Promise.all([
    importLibrary('maps'),
    importLibrary('marker'),
  ]).then(([, markerLibrary]) => ({
    maps: window.google.maps,
    AdvancedMarkerElement: markerLibrary.AdvancedMarkerElement,
    PinElement: markerLibrary.PinElement,
  }));

  return loadPromise;
}
