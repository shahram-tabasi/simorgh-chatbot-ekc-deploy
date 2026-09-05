import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";

// Strip any trailing slash from Vite's BASE_URL so React Router matches
// the subpath cleanly (it accepts either form, this just normalises).
const basename = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/";

export function AppRouter() {
  return <BrowserRouter basename={basename}>
        <Routes>
          <Route path="/" element={<App />} />
        </Routes>
    </BrowserRouter>;
}