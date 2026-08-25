import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ReviewApp from "../app/ReviewApp";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("앱을 표시할 영역을 찾지 못했습니다.");

createRoot(root).render(
  <StrictMode>
    <ReviewApp />
  </StrictMode>,
);
