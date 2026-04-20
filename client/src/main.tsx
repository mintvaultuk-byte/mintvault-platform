import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/v2-tokens.css";

// v2 fonts: Fraunces (display italic), Geist (body), JetBrains Mono (code)
import "@fontsource/fraunces/400-italic.css";
import "@fontsource/fraunces/500-italic.css";
import "@fontsource/fraunces/600-italic.css";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource-variable/geist";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

createRoot(document.getElementById("root")!).render(<App />);
