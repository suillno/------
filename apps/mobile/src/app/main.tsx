import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "@meeting/ui";
import { platform } from "../platform";

const root = document.getElementById("root");
if (!root) throw new Error("#root 요소가 없습니다");

createRoot(root).render(
  <StrictMode>
    <MobileApp platform={platform} />
  </StrictMode>,
);
