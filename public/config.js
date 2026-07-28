"use strict";

// Replace this placeholder after deploying the FastAPI backend to Render.
const ONLINE_API_URL =
  "https://ose-arima-sarima-backend.onrender.com";

const queryApi =
  new URLSearchParams(window.location.search).get("api");

const isLocal =
  ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.OSE_API_BASE = (
  queryApi ||
  (isLocal ? "http://127.0.0.1:8000" : ONLINE_API_URL)
).replace(/\/$/, "");
