// Self-host Inter font so the browser never has to fetch from
// fonts.googleapis.com (blocked on Iran ISPs — caused 30s TLS hangs
// on first page load).
import '@fontsource-variable/inter';
import './index.css';
import React from "react";
import { render } from "react-dom";
import App from "./App";
render(<App />, document.getElementById("root"));