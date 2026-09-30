"use strict";

(function () {
  const HOME_API   = "https://arima-sarima.ose.vn";                       // máy desktop
  const RENDER_API = "https://ose-arima-sarima-backend.onrender.com";     // dự phòng
  const LOCAL_API  = "http://127.0.0.1:8003";                             // chạy uvicorn trên máy dev

  const clean = (u) => u.replace(/\/$/, "");
  const done  = (u) => { window.OSE_API_BASE = clean(u); window.OSE_API_READY = Promise.resolve(window.OSE_API_BASE); };

  // Giữ tính năng cũ: ?api=<URL> để ép dùng một backend cụ thể
  const queryApi = new URLSearchParams(window.location.search).get("api");
  if (queryApi) return done(queryApi);

  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return done(LOCAL_API);

  // Mặc định dùng máy desktop; nếu không phản hồi trong 4 giây thì chuyển sang Render
  window.OSE_API_BASE = HOME_API;
  window.OSE_API_READY = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(HOME_API + "/api/health", { signal: ctrl.signal, cache: "no-store" });
      if (r.ok) return HOME_API;
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }
    console.warn("[OSE] Máy chủ chính không phản hồi, chuyển sang Render");
    window.OSE_API_BASE = RENDER_API;
    return RENDER_API;
  })();
})();
