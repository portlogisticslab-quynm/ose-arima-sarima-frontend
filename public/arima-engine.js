/* ARIMA / SARIMA calculation engine (browser).
   Ported 1:1 from ose-arima-sarima-backend/engine.py + schemas.py — no server needed.
   Conditional least squares with iterative residual regression, Monte Carlo
   forecasting and one-step-ahead diagnostics. Same inputs/outputs as the former
   /api/explore, /api/estimate, /api/forecast and /api/errors endpoints. */
(function (global) {
"use strict";

const EPS = 1e-12;

// ------------------------------------------------------------------
// Validation (mirrors schemas.py)
// ------------------------------------------------------------------

function fail(message) { throw new Error(message); }

function intInRange(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.floor(number) !== number) fail(`${name} must be an integer.`);
  if (number < min || number > max) fail(`${name} must be between ${min} and ${max}.`);
  return number;
}

function normalizeLags(value, name) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  const result = [...new Set(list.map(item => {
    const number = Number(item);
    if (!Number.isFinite(number)) fail(`${name}: lag values must be integers.`);
    return Math.trunc(number);
  }))].sort((a, b) => a - b);
  if (result.some(item => item < 1)) fail("All lag values must be positive integers.");
  return result;
}

function normalizeConfig(config) {
  const c = config || {};
  return {
    d: intInRange(c.d, "d", 0, 3, 0),
    seasonal_differencing: Boolean(c.seasonal_differencing),
    seasonal_period: intInRange(c.seasonal_period, "seasonal_period", 0, 100000, 0),
    ar_lags: normalizeLags(c.ar_lags, "ar_lags"),
    ma_lags: normalizeLags(c.ma_lags, "ma_lags"),
    seasonal_ar_units: normalizeLags(c.seasonal_ar_units, "seasonal_ar_units"),
    seasonal_ma_units: normalizeLags(c.seasonal_ma_units, "seasonal_ma_units")
  };
}

function asSeries(data) {
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) fail("The time series must be one-dimensional.");
  if (data.length > 100000) fail("At most 100000 observations are supported.");
  const values = Float64Array.from(data, Number);
  if (values.length < 8) fail("At least 8 numeric observations are required.");
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) fail("The time series contains NaN or infinite values.");
  }
  return values;
}

// ------------------------------------------------------------------
// Small numeric helpers
// ------------------------------------------------------------------

function mean(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return values.length ? total / values.length : NaN;
}

function diff(values) {
  const out = new Float64Array(values.length - 1);
  for (let i = 1; i < values.length; i++) out[i - 1] = values[i] - values[i - 1];
  return out;
}

/* Python "{x:.8g}" formatting */
function formatG(value, precision = 8) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : (value > 0 ? "inf" : "-inf");
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const exponent = Number(value.toExponential(precision - 1).split("e")[1]);
  if (exponent < -4 || exponent >= precision) {
    let [mantissa, exp] = value.toExponential(precision - 1).split("e");
    if (mantissa.includes(".")) mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
    const sign = exp[0] === "-" ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  let fixed = value.toFixed(Math.max(0, precision - 1 - exponent));
  if (fixed.includes(".")) fixed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
}

/* numpy.quantile, default "linear" method, on an already sorted array */
function quantileSorted(sorted, q) {
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/* Solve A x = b with partial pivoting; returns null when singular */
function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (!(best > 0) || !Number.isFinite(best)) return null;
    if (pivot !== col) { const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
    const pivotRow = M[col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivotRow[col];
      if (factor === 0) continue;
      const row = M[r];
      for (let k = col; k <= n; k++) row[k] -= factor * pivotRow[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k];
    x[i] = s / M[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/* (X'X + ridge I) beta = X'y ; fallback = minimum-norm least squares via a
   stronger, scale-aware ridge (numpy uses lstsq; only hit on exact singularity). */
function ridgeLeastSquares(xtx, xty, ridge = 1e-8) {
  const k = xty.length;
  const A = xtx.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v)));
  const beta = gaussSolve(A, xty);
  if (beta) return beta;
  let trace = 0;
  for (let i = 0; i < k; i++) trace += Math.abs(xtx[i][i]);
  const strong = Math.max(trace / Math.max(k, 1), 1) * 1e-10 + ridge;
  const B = xtx.map((row, i) => row.map((v, j) => (i === j ? v + strong : v)));
  const fallback = gaussSolve(B, xty);
  if (!fallback) {
    throw new Error(
      "Numerical calculation failed: the residual regression diverged. " +
      "Try fewer MA lags or a different differencing order."
    );
  }
  return fallback;
}

/* Seeded normal generator (numpy's PCG64 stream cannot be reproduced; any seed
   gives repeatable paths in this browser engine). */
function makeNormalRng(seed) {
  let a = (seed === null || seed === undefined)
    ? (Math.floor(Math.random() * 4294967296) >>> 0)
    : (Number(seed) >>> 0);
  const uniform = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  let spare = null;
  return function normal(mu, sigma) {
    if (spare !== null) { const z = spare; spare = null; return mu + sigma * z; }
    const u1 = uniform();
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return mu + sigma * r * Math.cos(2 * Math.PI * u2);
  };
}

// ------------------------------------------------------------------
// Lag specification and differencing
// ------------------------------------------------------------------

function collectLagSpec(config) {
  const D = config.seasonal_differencing ? 1 : 0;
  const s = D ? config.seasonal_period : 0;

  if ((config.seasonal_ar_units.length || config.seasonal_ma_units.length) && s < 2) {
    fail("Seasonal AR/MA lags require seasonal_period >= 2.");
  }

  const seasonalArLags = config.seasonal_ar_units.map(unit => unit * s);
  const seasonalMaLags = config.seasonal_ma_units.map(unit => unit * s);
  const uniqueSorted = list => [...new Set(list)].sort((x, y) => x - y);

  return {
    ar_lags: [...config.ar_lags],
    ma_lags: [...config.ma_lags],
    seasonal_ar_units: [...config.seasonal_ar_units],
    seasonal_ma_units: [...config.seasonal_ma_units],
    seasonal_ar_lags: seasonalArLags,
    seasonal_ma_lags: seasonalMaLags,
    combined_ar_lags: uniqueSorted([...config.ar_lags, ...seasonalArLags]),
    combined_ma_lags: uniqueSorted([...config.ma_lags, ...seasonalMaLags])
  };
}

function buildDifferenceLayers(data, config) {
  const original = asSeries(data);
  const D = config.seasonal_differencing ? 1 : 0;
  const s = D ? Math.trunc(config.seasonal_period) : 0;
  const d = Math.trunc(config.d);

  let seasonalLayer;
  if (D) {
    if (s < 2 || s >= original.length) {
      fail("Seasonal period must be at least 2 and smaller than the series length.");
    }
    seasonalLayer = new Float64Array(original.length - s);
    for (let i = 0; i < seasonalLayer.length; i++) seasonalLayer[i] = original[i + s] - original[i];
  } else {
    seasonalLayer = Float64Array.from(original);
  }

  const ordinaryLayers = [seasonalLayer];
  for (let k = 0; k < d; k++) {
    const previous = ordinaryLayers[ordinaryLayers.length - 1];
    if (previous.length < 2) fail("Too few observations remain after differencing.");
    ordinaryLayers.push(diff(previous));
  }

  if (ordinaryLayers[ordinaryLayers.length - 1].length < 4) {
    fail("Too few observations remain after differencing.");
  }

  return { D, s, d, original, ordinaryLayers, transformed: ordinaryLayers[ordinaryLayers.length - 1] };
}

// ------------------------------------------------------------------
// Exploration: signal, spectrum, ACF / PACF
// ------------------------------------------------------------------

function autocorrelation(values, maxLag) {
  const m = mean(values);
  const centered = Float64Array.from(values, v => v - m);
  let denominator = 0;
  for (let i = 0; i < centered.length; i++) denominator += centered[i] * centered[i];
  const result = new Array(maxLag + 1).fill(0);
  if (denominator <= EPS) return result;
  result[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let total = 0;
    for (let i = lag; i < centered.length; i++) total += centered[i] * centered[i - lag];
    result[lag] = total / denominator;
  }
  return result;
}

function partialAutocorrelation(values, maxLag) {
  const acf = autocorrelation(values, maxLag);
  const pacf = new Array(maxLag + 1).fill(0);
  pacf[0] = 1;
  const phi = Array.from({ length: maxLag + 1 }, () => new Float64Array(maxLag + 1));
  let variance = 1;

  for (let k = 1; k <= maxLag; k++) {
    let numerator = acf[k];
    for (let j = 1; j < k; j++) numerator -= phi[k - 1][j] * acf[k - j];
    const coefficient = Math.abs(variance) > EPS ? numerator / variance : 0;
    phi[k][k] = coefficient;
    for (let j = 1; j < k; j++) phi[k][j] = phi[k - 1][j] - coefficient * phi[k - 1][k - j];
    variance *= 1 - coefficient * coefficient;
    pacf[k] = coefficient;
  }
  return pacf;
}

/* numpy.fft.rfft amplitude |X_k| / n for k = 0..floor(n/2); n <= 4096 */
function rfftAmplitudes(x) {
  const n = x.length;
  const half = Math.floor(n / 2);
  const cosTable = new Float64Array(n);
  const sinTable = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }
  const frequencies = new Array(half + 1);
  const amplitudes = new Array(half + 1);
  for (let k = 0; k <= half; k++) {
    let re = 0;
    let im = 0;
    let index = 0;
    for (let t = 0; t < n; t++) {
      re += x[t] * cosTable[index];
      im -= x[t] * sinTable[index];
      index += k;
      if (index >= n) index -= n;
    }
    frequencies[k] = k / n;
    amplitudes[k] = Math.hypot(re, im) / n;
  }
  return { frequencies, amplitudes };
}

function exploreSeries(data, config, meanCorrected, lagsToPlot, correlationType) {
  const layers = buildDifferenceLayers(data, config);
  let values = Float64Array.from(layers.transformed);
  if (meanCorrected) {
    const m = mean(values);
    values = values.map(v => v - m);
  }

  const n = Math.min(values.length, 4096);
  let sampled = values;
  if (values.length > n) {
    const step = Math.ceil(values.length / n);
    const picked = [];
    for (let i = 0; i < values.length && picked.length < n; i += step) picked.push(values[i]);
    sampled = Float64Array.from(picked);
  }
  const sampledMean = mean(sampled);
  const centered = sampled.map(v => v - sampledMean);
  const spectrum = rfftAmplitudes(centered);

  const maxLag = Math.min(Math.trunc(lagsToPlot), values.length - 2);
  const type = String(correlationType).toUpperCase();
  const correlations = type === "ACF"
    ? autocorrelation(values, maxLag)
    : partialAutocorrelation(values, maxLag);

  return {
    signal: Array.from(values),
    differencing: { d: layers.d, D: layers.D, s: layers.s },
    spectrum,
    correlation: {
      type,
      lags: Array.from({ length: maxLag + 1 }, (_, i) => i),
      values: correlations,
      confidence_bound: 1.96 / Math.sqrt(values.length)
    }
  };
}

// ------------------------------------------------------------------
// Estimation: conditional least squares with iterative residual regression
// ------------------------------------------------------------------

function estimateModel(data, config, sourceColumn = "Value") {
  const layers = buildDifferenceLayers(data, config);
  const series = layers.transformed;
  const lagSpec = collectLagSpec(config);
  const arLags = lagSpec.combined_ar_lags;
  const maLags = lagSpec.combined_ma_lags;
  const maxLag = Math.max(0, ...arLags, ...maLags);
  const N = series.length;

  if (N <= maxLag + 8) {
    fail("Not enough observations remain for the selected differencing and lag structure.");
  }

  const p = arLags.length;
  const q = maLags.length;
  const k = 1 + p + q;
  let residuals = new Float64Array(N);
  let coefficients = new Array(p + q).fill(0);
  let intercept = mean(series);
  const row = new Float64Array(k);

  for (let iteration = 0; iteration < 10; iteration++) {
    const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
    const xty = new Array(k).fill(0);
    for (let t = maxLag; t < N; t++) {
      row[0] = 1;
      for (let i = 0; i < p; i++) row[1 + i] = series[t - arLags[i]];
      for (let i = 0; i < q; i++) row[1 + p + i] = residuals[t - maLags[i]];
      const y = series[t];
      for (let i = 0; i < k; i++) {
        const ri = row[i];
        xty[i] += ri * y;
        const xi = xtx[i];
        for (let j = 0; j < k; j++) xi[j] += ri * row[j];
      }
    }

    const beta = ridgeLeastSquares(xtx, xty);
    intercept = beta[0];
    coefficients = beta.slice(1);
    const arCoefficients = coefficients.slice(0, p);
    const maCoefficients = coefficients.slice(p);

    const newResiduals = new Float64Array(N);
    for (let t = maxLag; t < N; t++) {
      let prediction = intercept;
      for (let i = 0; i < p; i++) prediction += arCoefficients[i] * series[t - arLags[i]];
      for (let i = 0; i < q; i++) prediction += maCoefficients[i] * newResiduals[t - maLags[i]];
      newResiduals[t] = series[t] - prediction;
    }

    let squared = 0;
    for (let t = 0; t < N; t++) {
      const delta = newResiduals[t] - residuals[t];
      squared += delta * delta;
    }
    const change = Math.sqrt(squared / N);
    residuals = newResiduals;
    if (change < 1e-8) break;
  }

  const arCoefficients = coefficients.slice(0, p);
  const maCoefficients = coefficients.slice(p);
  let sse = 0;
  for (let t = maxLag; t < N; t++) sse += residuals[t] * residuals[t];
  const degrees = Math.max((N - maxLag) - coefficients.length - 1, 1);
  const sigma2 = Math.max(sse / degrees, EPS);

  return {
    intercept,
    ar_lags: arLags,
    ma_lags: maLags,
    ar_coefficients: arCoefficients,
    ma_coefficients: maCoefficients,
    residuals,
    sigma2,
    transformed_series: Float64Array.from(series),
    max_lag: maxLag,
    layers,
    lag_spec: lagSpec,
    source_column: sourceColumn
  };
}

function modelToResponse(model) {
  const joinOrNone = list => (list.length ? list.join(", ") : "(none)");
  const lines = [
    "ESTIMATED MODEL (browser engine)",
    "",
    `Source column: ${model.source_column}`,
    `Samples: ${model.layers.original.length}`,
    `Differencing: d=${model.layers.d}, D=${model.layers.D}, s=${model.layers.s}`,
    `AR lags: ${joinOrNone(model.ar_lags)}`,
    `MA lags: ${joinOrNone(model.ma_lags)}`,
    `Seasonal AR units: ${joinOrNone(model.lag_spec.seasonal_ar_units)}`,
    `Seasonal MA units: ${joinOrNone(model.lag_spec.seasonal_ma_units)}`,
    "",
    `Intercept: ${formatG(model.intercept)}`,
    `Innovation variance: ${formatG(model.sigma2)}`
  ];
  model.ar_lags.forEach((lag, i) => lines.push(`AR(${lag}) = ${formatG(model.ar_coefficients[i])}`));
  model.ma_lags.forEach((lag, i) => lines.push(`MA(${lag}) = ${formatG(model.ma_coefficients[i])}`));

  const warnings = [];
  if (model.ar_coefficients.some(c => Math.abs(c) > 1.5)) {
    warnings.push("Large AR coefficients detected; inspect stationarity and lag selection.");
  }
  if (model.sigma2 <= 1e-10) {
    warnings.push("Innovation variance is extremely small; the model may be over-fitted.");
  }

  return {
    summary: lines.join("\n"),
    source_column: model.source_column,
    sample_count: model.layers.original.length,
    differencing: { d: model.layers.d, D: model.layers.D, s: model.layers.s },
    intercept: model.intercept,
    sigma2: model.sigma2,
    ar_lags: [...model.ar_lags],
    ma_lags: [...model.ma_lags],
    ar_coefficients: [...model.ar_coefficients],
    ma_coefficients: [...model.ma_coefficients],
    residual_count: model.residuals.length,
    warnings
  };
}

// ------------------------------------------------------------------
// Monte Carlo forecasting
// ------------------------------------------------------------------

/* Prepares the fixed history tails once; each simulated path only touches
   O(maxLag + s + horizon) memory instead of copying the full series. */
function prepareSimulation(model, horizon) {
  const z = model.transformed_series;
  const e = model.residuals;
  const tailLength = Math.min(model.max_lag, z.length);
  const layers = model.layers;
  const seasonalTail = layers.D === 1 ? layers.s : 0;
  return {
    tailLength,
    zTail: z.slice(z.length - tailLength),
    eTail: e.slice(e.length - tailLength),
    lastLevels: layers.ordinaryLayers.map(layer => layer[layer.length - 1]),
    seasonalTail,
    originalTail: layers.original.slice(layers.original.length - seasonalTail),
    zBuffer: new Float64Array(tailLength + horizon),
    eBuffer: new Float64Array(tailLength + horizon),
    levels: new Float64Array(layers.ordinaryLayers.length),
    originalBuffer: new Float64Array(seasonalTail + horizon)
  };
}

function simulatePath(model, horizon, normal, prep) {
  const { tailLength, zBuffer, eBuffer, levels, originalBuffer, seasonalTail } = prep;
  zBuffer.set(prep.zTail);
  eBuffer.set(prep.eTail);
  levels.set(prep.lastLevels);
  originalBuffer.set(prep.originalTail);

  const arLags = model.ar_lags;
  const maLags = model.ma_lags;
  const arC = model.ar_coefficients;
  const maC = model.ma_coefficients;
  const sigma = Math.sqrt(model.sigma2);
  const top = levels.length - 1;
  const path = new Float64Array(horizon);

  for (let h = 0; h < horizon; h++) {
    const t = tailLength + h;
    let prediction = model.intercept;
    for (let i = 0; i < arLags.length; i++) prediction += arC[i] * zBuffer[t - arLags[i]];
    for (let i = 0; i < maLags.length; i++) prediction += maC[i] * eBuffer[t - maLags[i]];
    const innovation = normal(0, sigma);
    const next = prediction + innovation;
    zBuffer[t] = next;
    eBuffer[t] = innovation;

    // invert ordinary differences (top layer = transformed series)
    levels[top] = next;
    let value = next;
    for (let level = top - 1; level >= 0; level--) {
      value = levels[level] + value;
      levels[level] = value;
    }

    let originalValue = value;
    if (model.layers.D === 1) {
      originalValue = value + originalBuffer[seasonalTail + h - model.layers.s];
    }
    originalBuffer[seasonalTail + h] = originalValue;
    path[h] = originalValue;
  }
  return path;
}

function forecastModel(model, horizon, pathsToDisplay, intervalPaths, seed) {
  const simulationCount = Math.max(intervalPaths, pathsToDisplay);
  const normal = makeNormalRng(seed);
  const prep = prepareSimulation(model, horizon);
  const allPaths = new Array(simulationCount);
  for (let i = 0; i < simulationCount; i++) allPaths[i] = simulatePath(model, horizon, normal, prep);

  const meanForecast = new Array(horizon);
  const lower = new Array(horizon);
  const upper = new Array(horizon);
  const column = new Float64Array(simulationCount);
  for (let h = 0; h < horizon; h++) {
    let total = 0;
    for (let i = 0; i < simulationCount; i++) {
      column[i] = allPaths[i][h];
      total += column[i];
    }
    meanForecast[h] = total / simulationCount;
    column.sort();
    lower[h] = quantileSorted(column, 0.025);
    upper[h] = quantileSorted(column, 0.975);
  }

  return {
    horizon,
    history: Array.from(model.layers.original),
    displayed_paths: allPaths.slice(0, pathsToDisplay).map(path => Array.from(path)),
    mean_forecast: meanForecast,
    lower_95: lower,
    upper_95: upper,
    simulation_paths: simulationCount,
    seed: seed === undefined ? null : seed
  };
}

// ------------------------------------------------------------------
// One-step-ahead errors
// ------------------------------------------------------------------

function invertOneObservedPoint(layers, transformedPrediction, transformedIndex) {
  let value = transformedPrediction;
  for (let level = layers.d - 1; level >= 0; level--) {
    const previousIndex = transformedIndex + layers.d - 1 - level;
    value += layers.ordinaryLayers[level][previousIndex];
  }
  if (layers.D === 1) {
    const seasonalLayerIndex = transformedIndex + layers.d;
    const originalIndex = seasonalLayerIndex + layers.s;
    return value + layers.original[originalIndex - layers.s];
  }
  return value;
}

function oneStepErrors(model, testWindow, lagShift) {
  const z = model.transformed_series;
  const residuals = new Float64Array(z.length);
  let pairs = [];
  const layers = model.layers;

  for (let j = model.max_lag; j < z.length; j++) {
    let prediction = model.intercept;
    for (let i = 0; i < model.ar_lags.length; i++) prediction += model.ar_coefficients[i] * z[j - model.ar_lags[i]];
    for (let i = 0; i < model.ma_lags.length; i++) prediction += model.ma_coefficients[i] * residuals[j - model.ma_lags[i]];
    residuals[j] = z[j] - prediction;

    const predictedOriginal = invertOneObservedPoint(layers, prediction, j);
    const originalIndex = j + layers.d + (layers.D ? layers.s : 0);
    if (originalIndex < layers.original.length) {
      pairs.push({ time: originalIndex + 1, actual: layers.original[originalIndex], predicted: predictedOriginal });
    }
  }

  if (!pairs.length) fail("No valid one-step-ahead predictions could be constructed.");

  pairs = pairs.slice(pairs.length - Math.min(testWindow, pairs.length));
  if (lagShift > 0 && pairs.length > lagShift) {
    const original = pairs;
    pairs = [];
    for (let i = 0; i < original.length - lagShift; i++) {
      pairs.push({ time: original[i + lagShift].time, actual: original[i + lagShift].actual, predicted: original[i].predicted });
    }
  } else if (lagShift < 0 && pairs.length > -lagShift) {
    const amount = -lagShift;
    const original = pairs;
    pairs = [];
    for (let i = 0; i < original.length - amount; i++) {
      pairs.push({ time: original[i].time, actual: original[i].actual, predicted: original[i + amount].predicted });
    }
  }

  if (pairs.length < 5) fail("Not enough valid one-step-ahead points to score.");

  const actual = pairs.map(item => item.actual);
  let sse = 0;
  for (const item of pairs) { const e = item.actual - item.predicted; sse += e * e; }
  const mse = sse / pairs.length;
  const rmse = Math.sqrt(mse);
  const actualMean = mean(actual);
  let sst = 0;
  for (const a of actual) sst += (a - actualMean) * (a - actualMean);
  const r2 = sst > EPS ? 1 - sse / sst : NaN;

  return { metrics: { mse, rmse, r2 }, pairs, count: pairs.length, lag_shift: lagShift };
}

// ------------------------------------------------------------------
// Public API — same request/response shapes as the former endpoints
// ------------------------------------------------------------------

function explore(request) {
  const r = request || {};
  const type = r.correlation_type === undefined ? "ACF" : String(r.correlation_type);
  if (!["ACF", "PACF"].includes(type)) fail("correlation_type must be ACF or PACF.");
  return exploreSeries(
    r.data,
    normalizeConfig(r.config),
    Boolean(r.mean_corrected),
    intInRange(r.lags_to_plot, "lags_to_plot", 1, 200, 20),
    type
  );
}

function fitFromRequest(r) {
  return estimateModel(r.data, normalizeConfig(r.config), r.source_column ? String(r.source_column) : "Value");
}

function estimate(request) {
  return modelToResponse(fitFromRequest(request || {}));
}

function forecast(request) {
  const r = request || {};
  const horizon = intInRange(r.horizon, "horizon", 1, 10000, 12);
  const pathsToDisplay = intInRange(r.paths_to_display, "paths_to_display", 1, 200, 20);
  const intervalPaths = intInRange(r.interval_paths, "interval_paths", 100, 5000, 500);
  const seed = r.seed === undefined || r.seed === null ? null : intInRange(r.seed, "seed", 0, Number.MAX_SAFE_INTEGER, null);
  const model = fitFromRequest(r);
  const result = forecastModel(model, horizon, pathsToDisplay, intervalPaths, seed);
  result.model = modelToResponse(model);
  return result;
}

function errors(request) {
  const r = request || {};
  const testWindow = intInRange(r.test_window, "test_window", 12, 100000, 200);
  const lagShift = intInRange(r.lag_shift, "lag_shift", -10000, 10000, 0);
  const model = fitFromRequest(r);
  const result = oneStepErrors(model, testWindow, lagShift);
  result.model = modelToResponse(model);
  return result;
}

const api = Object.freeze({
  version: "1.0.0-browser",
  explore,
  estimate,
  forecast,
  errors,
  _internal: Object.freeze({
    autocorrelation, partialAutocorrelation, rfftAmplitudes, formatG, quantileSorted,
    /* deterministic path (all innovations = 0), used by the parity tests */
    zeroNoisePath(request, horizon) {
      const model = fitFromRequest(request);
      return Array.from(simulatePath(model, horizon, () => 0, prepareSimulation(model, horizon)));
    }
  })
});

global.ArimaEngine = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
