import { Routes, Route } from "react-router-dom";

function Dashboard() {
  return (
    <div className="dashboard">
      <h1>NexNote</h1>
      <p className="subtitle">AI-assisted Markdown knowledge wiki</p>
    </div>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-header">
          <span className="logo">NexNote</span>
        </div>
        <div className="sidebar-content">
          {/* Folder tree will go here */}
        </div>
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </main>
    </div>
  );
}
