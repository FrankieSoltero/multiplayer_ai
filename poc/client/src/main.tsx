import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// StrictMode omitted: double-mounted effects would double-join the shared ws session

createRoot(document.getElementById('root')!).render(
  <App />
)
