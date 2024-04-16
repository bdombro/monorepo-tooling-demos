import React from "react";
import "./App.css";
import { lib4Var } from "@app/lib4";

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <p>lib4Var = {lib4Var}</p>
        <p>
          Edit <code>src/App.tsx</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

export default App;
