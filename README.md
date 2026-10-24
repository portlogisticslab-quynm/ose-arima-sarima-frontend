# OSE ARIMA / SARIMA Web App

Static browser app for ARIMA/SARIMA time-series analysis. **All calculations run
in the browser** (`public/arima-engine.js`); no backend server is needed and the
data never leaves the user's device.

## Structure

```text
public/
  index.html
  styles.css
  arima-engine.js   calculation engine (ported 1:1 from ose-arima-sarima-backend/engine.py)
  app.js            UI, charts, Excel import/export
  _headers
examples/
  demo_monthly_demand.csv
```

## Engine

`window.ArimaEngine` exposes the same request/response shapes as the former API:

| Function | Former endpoint |
|---|---|
| `ArimaEngine.explore(req)` | `POST /api/explore` |
| `ArimaEngine.estimate(req)` | `POST /api/estimate` |
| `ArimaEngine.forecast(req)` | `POST /api/forecast` |
| `ArimaEngine.errors(req)` | `POST /api/errors` |

Conditional least squares with iterative residual regression, Monte Carlo
forecasting (empirical 95% interval) and one-step-ahead errors (MSE, RMSE, R²).
Estimation, ACF/PACF, spectrum and one-step errors match the Python backend to
about 1e-9 relative for well-conditioned models. Forecast paths are random, so
they agree statistically, not path by path (numpy's random stream is not
reproduced). It does not reproduce MATLAB Econometrics Toolbox
maximum-likelihood estimation exactly.

## Local test

```powershell
cd C:\apps\ose-arima-sarima-frontend\public
python -m http.server 5500
```

Open `http://127.0.0.1:5500`.

## Cloudflare Pages

- Framework preset: `None`
- Production branch: `main`
- Root directory: leave blank
- Build command: `exit 0`
- Build output directory: `public`
