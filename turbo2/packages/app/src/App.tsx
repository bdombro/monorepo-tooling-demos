import React from "react";
import { lib2Var } from "@mydomain/lib2";
import "./App.css";

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <p>libVar = {lib2Var}</p>
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
