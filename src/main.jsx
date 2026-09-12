import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import { ErrorBoundary } from './ErrorBoundary.jsx';

window.addEventListener('error', event => window.workshop?.reportError(String(event.error || event.message)).catch(() => {}));
window.addEventListener('unhandledrejection', event => window.workshop?.reportError(String(event.reason)).catch(() => {}));

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>
);
