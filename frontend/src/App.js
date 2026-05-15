import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Admin from "./pages/Admin";
import { Toaster } from "./components/ui/sonner";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{ style: { background: "#162018", border: "1px solid #2A3A2D", color: "#fff" } }}
      />
    </BrowserRouter>
  );
}

export default App;
