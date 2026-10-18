// ======================================================
// Third-party UI assets, bundled rather than loaded from CDNs.
//
// These used to arrive as globals from four separate CDN <script>/<link> tags
// in index.html: jsDelivr (Chart.js + date adapter), unpkg (Grid.js, since
// replaced by src/table.js), cdnjs
// (Font Awesome) and Google Fonts. That put four render-blocking third parties
// on the critical path with no SRI and no fallback. Bundling them lets the
// production CSP stay at `default-src 'self'`.
//
// Chart.js no longer comes through here: it lives in src/chart-setup.js and
// is imported only by the views that draw a chart, so it loads with them
// rather than ahead of the first paint.
// ======================================================

// Font Awesome, solid icons only, cut down to the ones the app uses
// (scripts/fa-subset.mjs). all.min.css was ~90 KB of CSS and three fonts.
// import '@fortawesome/fontawesome-free/css/all.min.css';  // replaced by the subset below
import './icons.css';
import '@fontsource-variable/inter';
