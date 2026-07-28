"use strict";

const state = {
  workbook: null,
  rows: [],
  data: [],
  fileName: "",
  sourceColumn: "",
  model: null,
  forecast: null,
  explorationTimer: null
};

const charts = {
  signal: null,
  spectrum: null,
  correlation: null,
  paths: null,
  interval: null
};

const API_BASE = window.OSE_API_BASE;

const fileInput = document.getElementById("fileInput");
const loadButton = document.getElementById("loadButton");
const fileNameBox = document.getElementById("fileName");
const sheetSelect = document.getElementById("sheetSelect");
const columnSelect = document.getElementById("columnSelect");
const meanCorrected = document.getElementById("meanCorrected");
const lagsToPlot = document.getElementById("lagsToPlot");
const trendD = document.getElementById("trendD");
const seasonalDiff = document.getElementById("seasonalDiff");
const seasonalPeriod = document.getElementById("seasonalPeriod");
const useAR = document.getElementById("useAR");
const useMA = document.getElementById("useMA");
const useSAR = document.getElementById("useSAR");
const useSMA = document.getElementById("useSMA");
const arLagsInput = document.getElementById("arLags");
const maLagsInput = document.getElementById("maLags");
const sarLagsInput = document.getElementById("sarLags");
const smaLagsInput = document.getElementById("smaLags");
const corrType = document.getElementById("corrType");
const estimateButton = document.getElementById("estimateButton");
const futureSamples = document.getElementById("futureSamples");
const pathCount = document.getElementById("pathCount");
const forecastButton = document.getElementById("forecastButton");
const saveButton = document.getElementById("saveButton");
const errorsButton = document.getElementById("errorsButton");
const testWindow = document.getElementById("testWindow");
const lagShift = document.getElementById("lagShift");
const mseValue = document.getElementById("mseValue");
const r2Value = document.getElementById("r2Value");
const rmseValue = document.getElementById("rmseValue");
const statusBox = document.getElementById("status");
const modelSummary = document.getElementById("modelSummary");
const backendStatus = document.getElementById("backendStatus");
const backendStatusText = document.getElementById("backendStatusText");

function setStatus(message, type = "") {
  statusBox.textContent = `Status: ${message}`;
  statusBox.className = `status ${type}`;
}

function setBackendStatus(message, type) {
  backendStatus.className = `backend-status ${type}`;
  backendStatusText.textContent = `Backend: ${message}`;
}

async function apiRequest(path, payload = null, options = {}) {
  if (!API_BASE || API_BASE.includes("REPLACE-WITH-YOUR-RENDER-URL")) {
    throw new Error(
      "Backend URL is not configured. Update public/config.js with the Render URL."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 120000
  );

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: payload === null ? "GET" : "POST",
      headers: payload === null ? undefined : { "Content-Type": "application/json" },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === "string"
        ? data.detail
        : `Backend request failed with HTTP ${response.status}.`;
      throw new Error(detail);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Backend request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBackend() {
  try {
    setBackendStatus("checking...", "checking");
    const health = await apiRequest("/api/health", null, { timeoutMs: 30000 });
    setBackendStatus(`online · v${health.version}`, "online");
  } catch (error) {
    setBackendStatus("offline or not configured", "offline");
  }
}

loadButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;

  resetStateForNewFile();
  try {
    if (typeof XLSX === "undefined") {
      throw new Error("The Excel/CSV library could not be loaded.");
    }
    setStatus("reading file...");
    const buffer = await file.arrayBuffer();
    state.workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    state.fileName = file.name;
    fileNameBox.textContent = file.name;
    sheetSelect.innerHTML = "";

    for (const name of state.workbook.SheetNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      sheetSelect.appendChild(option);
    }
    sheetSelect.disabled = false;
    loadSelectedSheet();
    setStatus("file loaded; select a numeric column.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

sheetSelect.addEventListener("change", loadSelectedSheet);
columnSelect.addEventListener("change", loadSelectedColumn);

function loadSelectedSheet() {
  if (!state.workbook) return;
  const worksheet = state.workbook.Sheets[sheetSelect.value];
  state.rows = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
  columnSelect.innerHTML = "";

  if (state.rows.length === 0) {
    columnSelect.disabled = true;
    columnSelect.innerHTML = '<option value="">No rows found</option>';
    setStatus("selected sheet contains no data.", "error");
    return;
  }

  const names = [...new Set(state.rows.flatMap(row => Object.keys(row)))];
  const numericColumns = names.filter(name =>
    state.rows.some(row => row[name] !== null && row[name] !== "" && Number.isFinite(Number(row[name])))
  );

  if (numericColumns.length === 0) {
    columnSelect.disabled = true;
    columnSelect.innerHTML = '<option value="">No numeric columns</option>';
    setStatus("selected sheet contains no numeric column.", "error");
    return;
  }

  for (const name of numericColumns) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    columnSelect.appendChild(option);
  }
  columnSelect.disabled = false;
  loadSelectedColumn();
}

function loadSelectedColumn() {
  const columnName = columnSelect.value;
  if (!columnName) return;

  const values = state.rows
    .map(row => Number(row[columnName]))
    .filter(Number.isFinite);

  if (values.length < 8) {
    state.data = [];
    setStatus("selected column must contain at least 8 numeric samples.", "error");
    return;
  }

  state.data = values;
  state.sourceColumn = columnName;
  state.model = null;
  state.forecast = null;
  setModelActions(false);
  modelSummary.textContent = "No model estimated.";
  resetMetrics();
  setStatus(`loaded ${values.length} samples from column "${columnName}".`, "success");
  scheduleExploration(0);
}

function resetStateForNewFile() {
  state.workbook = null;
  state.rows = [];
  state.data = [];
  state.model = null;
  state.forecast = null;
  state.sourceColumn = "";
  setModelActions(false);
  modelSummary.textContent = "No model estimated.";
  resetMetrics();
  Object.keys(charts).forEach(destroyChart);
}

function setModelActions(enabled) {
  futureSamples.disabled = !enabled;
  pathCount.disabled = !enabled;
  forecastButton.disabled = !enabled;
  saveButton.disabled = true;
}

function resetMetrics() {
  mseValue.textContent = "—";
  r2Value.textContent = "—";
  rmseValue.textContent = "—";
}

seasonalDiff.addEventListener("change", () => {
  seasonalPeriod.disabled = !seasonalDiff.checked;
  seasonalPeriod.value = seasonalDiff.checked
    ? Math.max(2, Number(seasonalPeriod.value) || 12)
    : 0;
  scheduleExploration();
});

[
  [useAR, arLagsInput],
  [useMA, maLagsInput],
  [useSAR, sarLagsInput],
  [useSMA, smaLagsInput]
].forEach(([checkbox, input]) => {
  checkbox.addEventListener("change", () => {
    input.disabled = !checkbox.checked;
    if (!checkbox.checked) input.value = "";
  });
});

[meanCorrected, lagsToPlot, trendD, seasonalPeriod, corrType].forEach(control => {
  control.addEventListener("change", () => scheduleExploration());
});

function clampInteger(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function validateControls() {
  trendD.value = clampInteger(Number(trendD.value), 0, 3, 0);
  lagsToPlot.value = clampInteger(Number(lagsToPlot.value), 1, 200, 20);
  futureSamples.value = clampInteger(Number(futureSamples.value), 1, 10000, 12);
  pathCount.value = clampInteger(Number(pathCount.value), 1, 200, 20);
  testWindow.value = clampInteger(Number(testWindow.value), 12, 100000, 200);
  if (seasonalDiff.checked) {
    seasonalPeriod.value = clampInteger(Number(seasonalPeriod.value), 2, 100000, 12);
  }
}

function parseLags(text) {
  if (!String(text || "").trim()) return [];
  const result = [];
  const tokens = String(text).split(/[,\s;]+/).map(item => item.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token.includes(":")) {
      const parts = token.split(":").map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) {
        const start = Math.floor(Math.min(...parts));
        const end = Math.floor(Math.max(...parts));
        for (let lag = start; lag <= end; lag++) if (lag >= 1) result.push(lag);
      }
    } else {
      const lag = Math.floor(Number(token));
      if (Number.isFinite(lag) && lag >= 1) result.push(lag);
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

function collectModelConfig() {
  validateControls();
  return {
    d: Number(trendD.value),
    seasonal_differencing: seasonalDiff.checked,
    seasonal_period: seasonalDiff.checked ? Number(seasonalPeriod.value) : 0,
    ar_lags: useAR.checked ? parseLags(arLagsInput.value) : [],
    ma_lags: useMA.checked ? parseLags(maLagsInput.value) : [],
    seasonal_ar_units: useSAR.checked ? parseLags(sarLagsInput.value) : [],
    seasonal_ma_units: useSMA.checked ? parseLags(smaLagsInput.value) : []
  };
}

function basePayload() {
  if (state.data.length < 8) throw new Error("Please load a valid time series first.");
  return {
    data: state.data,
    config: collectModelConfig(),
    source_column: state.sourceColumn || "Value"
  };
}

function scheduleExploration(delay = 350) {
  if (state.data.length < 8) return;
  clearTimeout(state.explorationTimer);
  state.explorationTimer = setTimeout(plotExploration, delay);
}

async function plotExploration() {
  try {
    const payload = {
      data: state.data,
      config: collectModelConfig(),
      mean_corrected: meanCorrected.checked,
      lags_to_plot: Number(lagsToPlot.value),
      correlation_type: corrType.value
    };
    setStatus("updating exploratory plots...");
    const result = await apiRequest("/api/explore", payload);
    plotSignal(result);
    plotSpectrum(result.spectrum);
    plotCorrelation(result.correlation);
    setStatus("exploratory plots updated.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

estimateButton.addEventListener("click", async () => {
  try {
    setStatus("estimating model on backend...");
    estimateButton.disabled = true;
    const result = await apiRequest("/api/estimate", basePayload());
    state.model = result;
    state.forecast = null;
    renderModelSummary(result);
    setModelActions(true);
    setStatus("model estimated.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    estimateButton.disabled = false;
  }
});

function renderModelSummary(model) {
  modelSummary.textContent = model.summary || "Model estimated.";
  const oldWarnings = document.querySelector(".warning-list");
  if (oldWarnings) oldWarnings.remove();
  if (Array.isArray(model.warnings) && model.warnings.length) {
    const list = document.createElement("ul");
    list.className = "warning-list";
    model.warnings.forEach(message => {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    });
    modelSummary.insertAdjacentElement("afterend", list);
  }
}

forecastButton.addEventListener("click", async () => {
  try {
    if (!state.model) throw new Error("Please estimate the model first.");
    validateControls();
    forecastButton.disabled = true;
    setStatus("simulating forecast paths on backend...");
    const payload = {
      ...basePayload(),
      horizon: Number(futureSamples.value),
      paths_to_display: Number(pathCount.value),
      interval_paths: Math.max(500, Number(pathCount.value)),
      seed: null
    };
    const result = await apiRequest("/api/forecast", payload, { timeoutMs: 180000 });
    state.forecast = result;
    state.model = result.model;
    renderModelSummary(result.model);
    plotForecastPaths(result);
    plotForecastInterval(result);
    saveButton.disabled = false;
    setStatus("forecast completed (paths + empirical 95% interval).", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    forecastButton.disabled = false;
  }
});

errorsButton.addEventListener("click", async () => {
  try {
    if (!state.model) throw new Error("Data and an estimated model are required.");
    errorsButton.disabled = true;
    setStatus("computing one-step-ahead errors...");
    const payload = {
      ...basePayload(),
      test_window: Number(testWindow.value),
      lag_shift: Math.floor(Number(lagShift.value) || 0)
    };
    const result = await apiRequest("/api/errors", payload);
    state.model = result.model;
    mseValue.textContent = formatNumber(result.metrics.mse);
    rmseValue.textContent = formatNumber(result.metrics.rmse);
    r2Value.textContent = formatNumber(result.metrics.r2);
    plotOneStepComparison(result.pairs);
    plotForecastActualScatter(result.pairs);
    setStatus("one-step-ahead errors computed.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    errorsButton.disabled = false;
  }
});

function destroyChart(name) {
  if (charts[name]) {
    charts[name].destroy();
    charts[name] = null;
  }
}

function basicChartOptions(xLabel, yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: "index" },
    scales: {
      x: { title: { display: true, text: xLabel } },
      y: { title: { display: true, text: yLabel } }
    }
  };
}

function xyChartOptions(xLabel, yLabel, beginAtZero = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: { type: "linear", title: { display: true, text: xLabel } },
      y: { beginAtZero, title: { display: true, text: yLabel } }
    }
  };
}

function plotSignal(result) {
  destroyChart("signal");
  const values = result.signal;
  const d = result.differencing;
  charts.signal = new Chart(document.getElementById("signalChart"), {
    type: "line",
    data: {
      labels: values.map((_, index) => index + 1),
      datasets: [{
        label: `Signal (D=${d.D}, s=${d.s}, d=${d.d})`,
        data: values,
        pointRadius: values.length <= 250 ? 2 : 0,
        borderWidth: 1.4,
        tension: 0
      }]
    },
    options: basicChartOptions("Time (sample)", "Value")
  });
}

function plotSpectrum(spectrum) {
  destroyChart("spectrum");
  charts.spectrum = new Chart(document.getElementById("spectrumChart"), {
    type: "line",
    data: {
      datasets: [{
        label: "Amplitude",
        data: spectrum.frequencies.map((x, index) => ({ x, y: spectrum.amplitudes[index] })),
        pointRadius: 0,
        borderWidth: 1.4
      }]
    },
    options: xyChartOptions("Frequency (cycles/sample)", "Amplitude", true)
  });
}

function plotCorrelation(correlation) {
  destroyChart("correlation");
  const upper = correlation.values.map(() => correlation.confidence_bound);
  const lower = correlation.values.map(() => -correlation.confidence_bound);
  charts.correlation = new Chart(document.getElementById("correlationChart"), {
    type: "bar",
    data: {
      labels: correlation.lags,
      datasets: [
        { label: correlation.type, data: correlation.values, borderWidth: 1 },
        { type: "line", label: "Upper 95%", data: upper, pointRadius: 0, borderDash: [5, 4], borderWidth: 1 },
        { type: "line", label: "Lower 95%", data: lower, pointRadius: 0, borderDash: [5, 4], borderWidth: 1 }
      ]
    },
    options: basicChartOptions("Lag", "Correlation")
  });
}

function plotForecastPaths(result) {
  destroyChart("paths");
  const futureX = result.mean_forecast.map((_, index) => result.history.length + index + 1);
  const datasets = [{
    label: "History",
    data: result.history.map((value, index) => ({ x: index + 1, y: value })),
    pointRadius: 0,
    borderWidth: 1.5
  }];
  result.displayed_paths.forEach((path, pathIndex) => {
    datasets.push({
      label: pathIndex === 0 ? "Simulated paths" : undefined,
      data: path.map((value, index) => ({ x: futureX[index], y: value })),
      pointRadius: 0,
      borderWidth: 0.8,
      showLine: true
    });
  });
  charts.paths = new Chart(document.getElementById("pathsChart"), {
    type: "scatter",
    data: { datasets },
    options: xyChartOptions("Time (sample)", "Value")
  });
}

function plotForecastInterval(result) {
  destroyChart("interval");
  const futureX = result.mean_forecast.map((_, index) => result.history.length + index + 1);
  charts.interval = new Chart(document.getElementById("intervalChart"), {
    type: "scatter",
    data: {
      datasets: [
        {
          type: "line",
          label: "History",
          data: result.history.map((value, index) => ({ x: index + 1, y: value })),
          pointRadius: 0,
          borderWidth: 1.2
        },
        {
          type: "line",
          label: "Forecast mean",
          data: futureX.map((x, index) => ({ x, y: result.mean_forecast[index] })),
          pointRadius: 2,
          borderWidth: 2
        },
        {
          type: "line",
          label: "Upper 95%",
          data: futureX.map((x, index) => ({ x, y: result.upper_95[index] })),
          pointRadius: 0,
          borderDash: [6, 4],
          borderWidth: 1.5
        },
        {
          type: "line",
          label: "Lower 95%",
          data: futureX.map((x, index) => ({ x, y: result.lower_95[index] })),
          pointRadius: 0,
          borderDash: [6, 4],
          borderWidth: 1.5
        }
      ]
    },
    options: xyChartOptions("Time (sample)", "Value")
  });
}

function plotOneStepComparison(pairs) {
  destroyChart("paths");
  charts.paths = new Chart(document.getElementById("pathsChart"), {
    type: "line",
    data: {
      labels: pairs.map(item => item.time),
      datasets: [
        { label: "Actual", data: pairs.map(item => item.actual), pointRadius: 0, borderWidth: 1.5 },
        { label: "One-step forecast", data: pairs.map(item => item.predicted), pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: basicChartOptions("Time", "Value")
  });
}

function plotForecastActualScatter(pairs) {
  destroyChart("interval");
  const actual = pairs.map(item => item.actual);
  const predicted = pairs.map(item => item.predicted);
  const combined = [...actual, ...predicted];
  const minimum = Math.min(...combined);
  const maximum = Math.max(...combined);
  charts.interval = new Chart(document.getElementById("intervalChart"), {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Forecast vs actual",
          data: predicted.map((value, index) => ({ x: value, y: actual[index] })),
          pointRadius: 3
        },
        {
          type: "line",
          label: "45-degree line",
          data: [{ x: minimum, y: minimum }, { x: maximum, y: maximum }],
          pointRadius: 0,
          borderDash: [6, 4],
          borderWidth: 1.3
        }
      ]
    },
    options: xyChartOptions("Forecast", "Actual")
  });
}

saveButton.addEventListener("click", () => {
  try {
    if (!state.forecast || !state.model) {
      throw new Error("No forecast results are available to save.");
    }
    if (typeof XLSX === "undefined") {
      throw new Error("The Excel export library could not be loaded.");
    }

    const workbook = XLSX.utils.book_new();
    const historyRows = state.forecast.history.map((value, index) => ({
      Time: index + 1,
      History: value
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(historyRows), "history");

    const pathRows = state.forecast.mean_forecast.map((_, horizonIndex) => {
      const row = {
        Horizon: horizonIndex + 1,
        Time: state.forecast.history.length + horizonIndex + 1
      };
      state.forecast.displayed_paths.forEach((path, pathIndex) => {
        row[`Path_${pathIndex + 1}`] = path[horizonIndex];
      });
      return row;
    });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(pathRows), "paths");

    const intervalRows = state.forecast.mean_forecast.map((value, index) => ({
      Horizon: index + 1,
      Time: state.forecast.history.length + index + 1,
      Forecast_Mean: value,
      Lower_95: state.forecast.lower_95[index],
      Upper_95: state.forecast.upper_95[index]
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(intervalRows), "interval");

    const modelRows = (state.model.summary || "").split("\n").map(line => ({ Model_Summary: line }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(modelRows), "model");
    XLSX.writeFile(workbook, `ARIMA_SARIMA_forecast_${timestamp()}.xlsx`);
    setStatus("forecast workbook exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

function formatNumber(value) {
  if (!Number.isFinite(value)) return "NaN";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e5 || absolute < 1e-4)) {
    return value.toExponential(5);
  }
  return value.toFixed(5);
}

function timestamp() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

window.addEventListener("DOMContentLoaded", () => {
  checkBackend();
});
