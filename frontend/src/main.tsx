import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary name="page"><App /></ErrorBoundary></StrictMode>);

import "./combined.css";
import "./simulation.css";
import "./professional.css";
import "./workspace.css";

import "./readability.css";
