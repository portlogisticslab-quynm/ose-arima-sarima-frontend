# OSE ARIMA / SARIMA Frontend

Static browser frontend for the OSE ARIMA/SARIMA time-series application.

## Structure

```text
public/
  index.html
  styles.css
  config.js
  app.js
  _headers
```

## Configure the API

Edit `public/config.js` and replace the placeholder with the actual Render URL:

```js
const ONLINE_API_URL = "https://your-arima-backend.onrender.com";
```

## Local test

```powershell
cd C:\ose-arima-sarima-frontend\public
python -m http.server 5500
```

Open `http://127.0.0.1:5500`. Localhost uses `http://127.0.0.1:8000` by default.
You can override the API URL with a query parameter:

```text
http://127.0.0.1:5500/?api=https://your-arima-backend.onrender.com
```

## Cloudflare Pages

- Framework preset: `None`
- Production branch: `main`
- Root directory: leave blank
- Build command: `exit 0`
- Build output directory: `public`

No Wrangler configuration is required for Pages.
