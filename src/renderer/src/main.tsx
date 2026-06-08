import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/tokens.css";
import "./styles/ide.css";

// Swallow Monaco's benign "Canceled" rejections. Monaco cancels internal async
// work (e.g. a folding/view-state restore racing a model swap during tab
// restore) by rejecting with a cancellation token whose name/message is
// "Canceled". It is harmless but surfaces as a noisy "Uncaught (in promise)
// Canceled". Suppress ONLY that exact shape; everything else propagates.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { name?: string; message?: string } | null;
  if (reason && (reason.name === "Canceled" || reason.message === "Canceled")) {
    event.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
